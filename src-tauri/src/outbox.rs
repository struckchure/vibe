use anyhow::Result;
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use crate::crypto::{self, build_wire_chat_from_message};
use crate::identity::Identity;
use crate::network::NetworkHandle;
use crate::store::{EphemeralStore, MessageRow};

pub fn send_message(
    identity: &Arc<Identity>,
    store: &Arc<Mutex<EphemeralStore>>,
    network: &NetworkHandle,
    peer_id: &str,
    body: &str,
) -> Result<MessageRow> {
    network.start()?;

    let contact = store.lock().get_contact(peer_id)?;

    let (wire, wire_bytes) = {
        let id = identity.as_ref();
        let mut guard = store.lock();
        crypto::build_wire_chat(id, &mut guard, peer_id, &contact.conversation_id, body)?
    };

    let mut msg = {
        let mut guard = store.lock();
        crypto::persist_outgoing_message(
            &mut guard,
            peer_id,
            &contact.conversation_id,
            body,
            wire.sent_at,
            &wire.id,
            true,
        )?
    };

    if network.overlay_peer_count() > 0 {
        if try_publish(identity, store, network, peer_id, &contact.conversation_id, &wire.id, wire_bytes)?
        {
            msg.pending = false;
        }
    }

    Ok(msg)
}

pub fn flush_outbox(
    identity: &Arc<Identity>,
    store: &Arc<Mutex<EphemeralStore>>,
    network: &NetworkHandle,
    app: &AppHandle,
) -> Result<usize> {
    if network.overlay_peer_count() == 0 {
        return Ok(0);
    }

    network.start()?;
    let pending = store.lock().list_pending_outgoing();
    let mut sent = 0usize;

    for item in pending {
        let contact = match store.lock().get_contact(&item.peer_id) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let wire_bytes = {
            let id = identity.as_ref();
            let mut guard = store.lock();
            match build_wire_chat_from_message(id, &mut guard, &item.message) {
                Ok((_, bytes)) => bytes,
                Err(e) => {
                    eprintln!("flush build wire: {e}");
                    continue;
                }
            }
        };

        if !try_publish(
            identity,
            store,
            network,
            &item.peer_id,
            &contact.conversation_id,
            &item.message.id,
            wire_bytes,
        )? {
            continue;
        }

        sent += 1;
        let _ = app.emit(
            "message-updated",
            serde_json::json!({
                "peerId": item.peer_id,
                "messageId": item.message.id,
                "pending": false,
            }),
        );
    }

    if sent > 0 {
        let _ = app.emit("outbox-flushed", sent);
    }

    Ok(sent)
}

fn try_publish(
    identity: &Arc<Identity>,
    store: &Arc<Mutex<EphemeralStore>>,
    network: &NetworkHandle,
    peer_id: &str,
    conversation_id: &str,
    message_id: &str,
    wire_bytes: Vec<u8>,
) -> Result<bool> {
    let _ = identity;
    network.subscribe_conversation(conversation_id)?;
    network.publish_message(conversation_id, wire_bytes)?;
    Ok(store.lock().mark_outgoing_sent(peer_id, message_id))
}

pub fn mark_outgoing_sent(
    store: &Arc<Mutex<EphemeralStore>>,
    app: &AppHandle,
    peer_id: &str,
    message_id: &str,
) -> Result<bool> {
    let updated = store.lock().mark_outgoing_sent(peer_id, message_id);
    if updated {
        let _ = app.emit(
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
