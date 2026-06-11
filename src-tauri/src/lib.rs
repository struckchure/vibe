mod crypto;
mod identity;
mod network;
mod noise_handshake;
mod noise_session;
mod store;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use base64::Engine;
use identity::Identity;
use noise_handshake::NoiseHandshakeState;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::crypto::{self as crypto_mod, conversation_id};
use crate::network::NetworkHandle;
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
    noise_handshake: Arc<NoiseHandshakeState>,
    network: NetworkHandle,
    app: AppHandle,
}

impl AppState {
    fn new(app: &tauri::App) -> Result<Self> {
        let data_dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&data_dir)?;
        let identity = Arc::new(RwLock::new(Arc::new(Identity::load_or_create(&data_dir)?)));
        let store = Arc::new(Mutex::new(EphemeralStore::load(&data_dir)?));
        let app_handle = app.handle().clone();
        let network = NetworkHandle::new(identity.read().clone(), store.clone(), app_handle.clone());
        Ok(Self {
            data_dir,
            identity,
            store,
            noise_handshake: Arc::new(NoiseHandshakeState::new()),
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
        self.noise_handshake.clear_all();
        self.network.restart(arc.clone());
        let _ = self.app.emit("identity-changed", ());
        Ok(())
    }

    fn mark_outgoing_sent(&self, peer_id: &str, message_id: &str) -> Result<bool, String> {
        let updated = self.store.lock().mark_outgoing_sent(peer_id, message_id);
        if updated {
            let _ = self.app.emit(
                "message-updated",
                serde_json::json!({
                    "peerId": peer_id,
                    "messageId": message_id,
                    "pending": false,
                }),
            );
        }
        Ok(updated)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityView {
    peer_id: String,
    public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoiseHandshakeMessage {
    message_b64: String,
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
        .map_err(|e| e.to_string())?;
    state.noise_handshake.clear_peer(&peer_id);
    Ok(())
}

#[tauri::command]
fn is_noise_ready(state: State<'_, AppState>, peer_id: String) -> Result<bool, String> {
    Ok(state.store.lock().is_noise_ready(&peer_id))
}

#[tauri::command]
fn noise_handshake_start(state: State<'_, AppState>, peer_id: String) -> Result<NoiseHandshakeMessage, String> {
    let message_b64 = noise_handshake::handshake_start(&state.noise_handshake, &peer_id)
        .map_err(|e| e.to_string())?;
    Ok(NoiseHandshakeMessage { message_b64 })
}

#[tauri::command]
fn noise_handshake_respond(
    state: State<'_, AppState>,
    peer_id: String,
    message_b64: String,
) -> Result<NoiseHandshakeMessage, String> {
    let message_b64 = noise_handshake::handshake_respond(&state.noise_handshake, &peer_id, &message_b64)
        .map_err(|e| e.to_string())?;
    Ok(NoiseHandshakeMessage { message_b64 })
}

#[tauri::command]
fn noise_handshake_finish_initiator(
    state: State<'_, AppState>,
    peer_id: String,
    message_b64: String,
) -> Result<NoiseHandshakeMessage, String> {
    let message_b64 = noise_handshake::handshake_finish_initiator(
        &state.noise_handshake,
        &state.store,
        &state.app,
        &peer_id,
        &message_b64,
    )
    .map_err(|e| e.to_string())?;
    Ok(NoiseHandshakeMessage { message_b64 })
}

#[tauri::command]
fn noise_handshake_finish_responder(
    state: State<'_, AppState>,
    peer_id: String,
    message_b64: String,
) -> Result<(), String> {
    noise_handshake::handshake_finish_responder(
        &state.noise_handshake,
        &state.store,
        &state.app,
        &peer_id,
        &message_b64,
    )
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrepareWireResult {
    wire_base64: String,
    message: MessageRow,
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

    let id = state.identity.read();
    let mut store = state.store.lock();
    if !store.is_noise_ready(&peer_id) {
        return Err("encryption session not established — connect and complete handshake first".into());
    }

    let (wire, wire_bytes) =
        crypto_mod::build_wire_chat(&id, &mut store, &peer_id, &contact.conversation_id, &body)
            .map_err(|e| e.to_string())?;

    let msg = crypto_mod::persist_outgoing_message(
        &mut store,
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
        message: msg,
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

    state.mark_outgoing_sent(&peer_id, &message_id)?;

    Ok(row)
}

#[tauri::command]
fn mark_outgoing_sent(
    state: State<'_, AppState>,
    peer_id: String,
    message_id: String,
) -> Result<MessageRow, String> {
    state.mark_outgoing_sent(&peer_id, &message_id)?;
    state
        .store
        .lock()
        .list_messages(&peer_id)
        .into_iter()
        .find(|m| m.id == message_id)
        .ok_or_else(|| "message not found".to_string())
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
    crypto_mod::ingest_wire_chat(&id, &mut store, &wire_bytes, &state.app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_messages(state: State<'_, AppState>, peer_id: String) -> Result<Vec<MessageRow>, String> {
    Ok(state.store.lock().list_messages(&peer_id))
}

#[tauri::command]
fn list_pending_outgoing(state: State<'_, AppState>) -> Result<Vec<MessageRow>, String> {
    Ok(state
        .store
        .lock()
        .list_pending_outgoing()
        .into_iter()
        .map(|item| item.message)
        .collect())
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
fn start_network(state: State<'_, AppState>) -> Result<(), String> {
    state.network.start().map_err(|e| e.to_string())?;
    state
        .network
        .subscribe_all_contacts()
        .map_err(|e| e.to_string())?;
    Ok(())
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
fn overlay_peer_count(state: State<'_, AppState>) -> Result<usize, String> {
    Ok(state.network.overlay_peer_count())
}

#[tauri::command]
fn is_overlay_peer_connected(state: State<'_, AppState>, peer_id: String) -> Result<bool, String> {
    Ok(state.network.is_peer_connected(&peer_id))
}

#[tauri::command]
fn dial_contact(state: State<'_, AppState>, addrs: Vec<String>) -> Result<(), String> {
    state.network.start().map_err(|e| e.to_string())?;
    state.network.dial_addrs(&addrs).map_err(|e| e.to_string())
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

#[tauri::command]
fn mark_conversation_read(state: State<'_, AppState>, peer_id: String) -> Result<(), String> {
    let message_ids = state.store.lock().mark_incoming_read(&peer_id);
    if message_ids.is_empty() {
        return Ok(());
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
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
            is_noise_ready,
            noise_handshake_start,
            noise_handshake_respond,
            noise_handshake_finish_initiator,
            noise_handshake_finish_responder,
            prepare_wire_message,
            persist_outgoing_message,
            encrypt_signaling,
            decrypt_signaling,
            ingest_dc_message,
            mark_outgoing_sent,
            list_messages,
            list_pending_outgoing,
            record_call_history,
            mark_conversation_read,
            start_network,
            subscribe_conversation,
            overlay_peer_count,
            is_overlay_peer_connected,
            dial_contact,
            publish_signaling,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
