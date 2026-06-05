mod crypto;
mod identity;
mod network;
mod outbox;
mod store;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use base64::Engine;
use identity::Identity;
use network::{NetworkHandle, RoomPeer, RoomStatus};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::crypto::{self as crypto_mod, conversation_id};
use crate::store::{ContactRow, EphemeralStore, MessageRow};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Msg(String),
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Msg(e.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub struct AppState {
    data_dir: PathBuf,
    identity: Arc<RwLock<Arc<Identity>>>,
    store: Arc<Mutex<EphemeralStore>>,
    network: NetworkHandle,
    app: AppHandle,
}

impl AppState {
    fn new(app: &tauri::App) -> Result<Self> {
        let data_dir = app.path().app_data_dir()?;
        let identity = Arc::new(RwLock::new(Arc::new(Identity::load_or_create(&data_dir)?)));
        let store = Arc::new(Mutex::new(EphemeralStore::load(&data_dir)?));
        let app_handle = app.handle().clone();
        let network =
            NetworkHandle::new(identity.read().clone(), store.clone(), app_handle.clone());
        Ok(Self {
            data_dir,
            identity,
            store,
            network,
            app: app_handle,
        })
    }

    fn with_identity<F, T>(&self, f: F) -> T
    where
        F: FnOnce(&Identity) -> T,
    {
        f(&self.identity.read())
    }

    fn apply_identity(&self, new: Identity) -> Result<()> {
        new.save(&self.data_dir)?;
        let arc = Arc::new(new);
        *self.identity.write() = arc.clone();
        self.store
            .lock()
            .clear()
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        self.network.restart(arc);
        let _ = self.app.emit("identity-changed", ());
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityView {
    peer_id: String,
    public_key: String,
}

#[tauri::command]
fn get_identity(state: State<'_, AppState>) -> Result<IdentityView, AppError> {
    Ok(state.with_identity(|id| IdentityView {
        peer_id: id.peer_id_b64(),
        public_key: id.peer_id_b64(),
    }))
}

#[tauri::command]
fn reveal_private_key(state: State<'_, AppState>) -> Result<String, AppError> {
    Ok(state.with_identity(|id| id.private_key_b64()))
}

#[tauri::command]
fn export_identity_backup(state: State<'_, AppState>) -> Result<String, AppError> {
    state
        .with_identity(|id| id.to_backup_json())
        .map_err(AppError::from)
}

#[tauri::command]
async fn export_identity_backup_file(state: State<'_, AppState>) -> Result<(), AppError> {
    let json = state
        .with_identity(|id| id.to_backup_json())
        .map_err(AppError::from)?;
    let path = state
        .app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name("vibe-identity-backup.json")
        .blocking_save_file();
    let Some(path) = path else {
        return Ok(());
    };
    let path = dialog_path(&path)?;
    std::fs::write(path, json).map_err(|e| AppError::Msg(e.to_string()))?;
    Ok(())
}

#[tauri::command]
fn import_identity_backup(state: State<'_, AppState>, json: String) -> Result<(), AppError> {
    let identity = Identity::from_backup(&json)?;
    state.apply_identity(identity)?;
    Ok(())
}

#[tauri::command]
async fn import_identity_backup_file(state: State<'_, AppState>) -> Result<(), AppError> {
    let path = state
        .app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    let Some(path) = path else {
        return Ok(());
    };
    let path = dialog_path(&path)?;
    let json = std::fs::read_to_string(path).map_err(|e| AppError::Msg(e.to_string()))?;
    import_identity_backup(state, json)
}

#[tauri::command]
fn regenerate_identity(state: State<'_, AppState>) -> Result<(), AppError> {
    let identity = Identity::generate()?;
    state.apply_identity(identity)?;
    Ok(())
}

#[tauri::command]
fn get_peer_id(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.with_identity(|id| id.peer_id_b64()))
}

#[tauri::command]
fn add_contact(
    state: State<'_, AppState>,
    peer_id: String,
    display_name: String,
) -> Result<ContactRow, String> {
    let local = state.with_identity(|id| *id.verifying_key.as_bytes());
    let remote = Identity::peer_id_from_b64(&peer_id).map_err(|e| e.to_string())?;
    if remote == local {
        return Err("cannot add yourself".into());
    }
    let conv_id = conversation_id(&local, &remote);
    let row = state
        .store
        .lock()
        .add_contact(&peer_id, &display_name, &conv_id)
        .map_err(|e| e.to_string())?;
    state.network.start().map_err(|e| e.to_string())?;
    state
        .network
        .subscribe_conversation(&conv_id)
        .map_err(|e| e.to_string())?;
    Ok(row)
}

#[tauri::command]
fn list_contacts(state: State<'_, AppState>) -> Result<Vec<ContactRow>, String> {
    Ok(state.store.lock().list_contacts())
}

#[tauri::command]
fn remove_contact(state: State<'_, AppState>, peer_id: String) -> Result<(), String> {
    state
        .store
        .lock()
        .remove_contact(&peer_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn room_status(state: State<'_, AppState>) -> Result<RoomStatus, String> {
    Ok(state.network.room_status())
}

#[tauri::command]
fn join_room(
    state: State<'_, AppState>,
    code: String,
    display_name: String,
) -> Result<(), String> {
    state.network.start().map_err(|e| e.to_string())?;
    state
        .network
        .join_room(&code, &display_name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn subscribe_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    state.network.start().map_err(|e| e.to_string())?;
    state
        .network
        .subscribe_conversation(&conversation_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn leave_room(state: State<'_, AppState>) -> Result<(), String> {
    state.network.leave_room().map_err(|e| e.to_string())
}

#[tauri::command]
fn list_room_peers(state: State<'_, AppState>) -> Result<Vec<RoomPeer>, String> {
    Ok(state.network.list_room_peers())
}

#[tauri::command]
fn start_network(state: State<'_, AppState>) -> Result<(), String> {
    state.network.start().map_err(|e| e.to_string())?;
    state
        .network
        .subscribe_all_contacts()
        .map_err(|e| e.to_string())?;
    let _ = outbox::flush_outbox(
        &state.identity.read(),
        &state.store,
        &state.network,
        &state.app,
    );
    Ok(())
}

#[tauri::command]
fn overlay_peer_count(state: State<'_, AppState>) -> Result<usize, String> {
    Ok(state.network.overlay_peer_count())
}

#[tauri::command]
fn publish_signaling(
    state: State<'_, AppState>,
    conversation_id: String,
    payload: String,
    wait_for_delivery: Option<bool>,
) -> Result<(), String> {
    let id = state.identity.read();
    let wire = crypto_mod::wrap_signal_wire(&id.peer_id_b64(), &payload)
        .map_err(|e| e.to_string())?;
    state.network.start().map_err(|e| e.to_string())?;
    if wait_for_delivery.unwrap_or(true) {
        state
            .network
            .publish_signaling(&conversation_id, &wire)
            .map_err(|e| e.to_string())
    } else {
        state
            .network
            .publish_signaling_best_effort(&conversation_id, &wire)
            .map_err(|e| e.to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrepareWireResult {
    wire_base64: String,
    sent_at: i64,
    message_id: String,
}

#[tauri::command]
fn prepare_wire_message(
    state: State<'_, AppState>,
    peer_id: String,
    body: String,
) -> Result<PrepareWireResult, String> {
    let contact = state
        .store
        .lock()
        .get_contact(&peer_id)
        .map_err(|e| e.to_string())?;

    let (wire, wire_bytes) = {
        let id = state.identity.read();
        let mut store = state.store.lock();
        crypto_mod::build_wire_chat(&id, &mut store, &peer_id, &contact.conversation_id, &body)
    }
    .map_err(|e| e.to_string())?;

    crypto_mod::persist_outgoing_message(
        &mut state.store.lock(),
        &peer_id,
        &contact.conversation_id,
        &body,
        wire.sent_at,
        &wire.id,
        true,
    )
    .map_err(|e| e.to_string())?;

    Ok(PrepareWireResult {
        wire_base64: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&wire_bytes),
        sent_at: wire.sent_at,
        message_id: wire.id,
    })
}

#[tauri::command]
fn persist_outgoing_message(
    state: State<'_, AppState>,
    peer_id: String,
    body: String,
    sent_at: i64,
    message_id: String,
) -> Result<MessageRow, String> {
    let contact = state
        .store
        .lock()
        .get_contact(&peer_id)
        .map_err(|e| e.to_string())?;

    {
        let mut guard = state.store.lock();
        let exists = guard
            .list_messages(&peer_id)
            .iter()
            .any(|m| m.id == message_id);
        if exists {
            guard
                .mark_outgoing_sent(&peer_id, &message_id)
                .then_some(())
                .ok_or_else(|| "message not found".to_string())?;
        } else {
            crypto_mod::persist_outgoing_message(
                &mut guard,
                &peer_id,
                &contact.conversation_id,
                &body,
                sent_at,
                &message_id,
                false,
            )
            .map_err(|e| e.to_string())?;
        }
    }

    let row = state
        .store
        .lock()
        .list_messages(&peer_id)
        .into_iter()
        .find(|m| m.id == message_id)
        .ok_or_else(|| "message not found".to_string())?;

    let _ = outbox::mark_outgoing_sent(&state.store, &state.app, &peer_id, &message_id);

    Ok(row)
}

#[tauri::command]
fn mark_outgoing_sent(
    state: State<'_, AppState>,
    peer_id: String,
    message_id: String,
) -> Result<(), String> {
    outbox::mark_outgoing_sent(&state.store, &state.app, &peer_id, &message_id)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn encrypt_signaling(
    state: State<'_, AppState>,
    peer_id: String,
    payload: String,
) -> Result<String, String> {
    let id = state.identity.read();
    let mut store = state.store.lock();
    crypto_mod::encrypt_for_peer(&id, &mut store, &peer_id, payload.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn decrypt_signaling(
    state: State<'_, AppState>,
    peer_id: String,
    payload: String,
) -> Result<String, String> {
    let id = state.identity.read();
    let mut store = state.store.lock();
    let plain =
        crypto_mod::decrypt_for_peer(&id, &mut store, &peer_id, &payload).map_err(|e| e.to_string())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

#[tauri::command]
fn ingest_dc_message(
    state: State<'_, AppState>,
    _peer_id: String,
    wire_base64: String,
) -> Result<(), String> {
    let wire_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&wire_base64)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(&wire_base64))
        .map_err(|e| e.to_string())?;

    let id = state.identity.read();
    let mut store = state.store.lock();
    let ingested =
        crypto_mod::ingest_wire_chat(&id, &mut store, &wire_bytes, &state.app).map_err(|e| e.to_string())?;
    if let Some(msg) = ingested {
        state
            .network
            .publish_ack(&msg.conversation_id, &msg.peer_id, &msg.id)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn send_message(
    state: State<'_, AppState>,
    peer_id: String,
    body: String,
) -> Result<MessageRow, String> {
    outbox::send_message(
        &state.identity.read(),
        &state.store,
        &state.network,
        &peer_id,
        &body,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn flush_outbox(state: State<'_, AppState>) -> Result<usize, String> {
    outbox::flush_outbox(
        &state.identity.read(),
        &state.store,
        &state.network,
        &state.app,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_messages(state: State<'_, AppState>, peer_id: String) -> Result<Vec<MessageRow>, String> {
    Ok(state.store.lock().list_messages(&peer_id))
}

#[tauri::command]
fn record_call_history(
    state: State<'_, AppState>,
    peer_id: String,
    conversation_id: String,
    outgoing: bool,
    media: String,
    outcome: String,
    duration_ms: Option<i64>,
) -> Result<MessageRow, String> {
    let msg = state
        .store
        .lock()
        .insert_call_history(
            &peer_id,
            &conversation_id,
            outgoing,
            &media,
            &outcome,
            duration_ms,
        )
        .map_err(|e| e.to_string())?;
    let _ = state
        .app
        .emit("message-received", crypto_mod::message_emit_payload(&msg));
    Ok(msg)
}

#[tauri::command]
fn mark_conversation_read(state: State<'_, AppState>, peer_id: String) -> Result<(), String> {
    state.network.start().map_err(|e| e.to_string())?;

    let contact = state
        .store
        .lock()
        .get_contact(&peer_id)
        .map_err(|e| e.to_string())?;

    let message_ids = state.store.lock().mark_incoming_read(&peer_id);
    if message_ids.is_empty() {
        return Ok(());
    }

    for message_id in message_ids {
        state
            .network
            .publish_read(&contact.conversation_id, &peer_id, &message_id)
            .map_err(|e| e.to_string())?;
    }

    let read_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let _ = state.app.emit(
        "conversation-read",
        serde_json::json!({ "peerId": peer_id, "readAt": read_at }),
    );
    Ok(())
}

fn dialog_path(path: &tauri_plugin_dialog::FilePath) -> Result<PathBuf, AppError> {
    path.as_path()
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Msg("unsupported file path".into()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = AppState::new(app)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_identity,
            reveal_private_key,
            export_identity_backup,
            export_identity_backup_file,
            import_identity_backup,
            import_identity_backup_file,
            regenerate_identity,
            get_peer_id,
            add_contact,
            list_contacts,
            remove_contact,
            room_status,
            join_room,
            subscribe_conversation,
            leave_room,
            list_room_peers,
            start_network,
            overlay_peer_count,
            publish_signaling,
            prepare_wire_message,
            persist_outgoing_message,
            encrypt_signaling,
            decrypt_signaling,
            ingest_dc_message,
            send_message,
            flush_outbox,
            mark_outgoing_sent,
            list_messages,
            record_call_history,
            mark_conversation_read,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
