use anyhow::{anyhow, Result};
use base64::Engine;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use crate::identity::Identity;
use crate::store::{EphemeralStore, MessageRow};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireChat {
    pub id: String,
    pub conversation_id: String,
    pub sender_peer_id: String,
    pub ciphertext: String,
    pub sent_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAck {
    pub message_id: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireRead {
    pub message_id: String,
    pub conversation_id: String,
}

pub fn conversation_id(local: &[u8; 32], remote: &[u8; 32]) -> String {
    let (a, b) = if local < remote {
        (local, remote)
    } else {
        (remote, local)
    };
    let mut hasher = Sha256::new();
    hasher.update(a);
    hasher.update(b);
    hex::encode(hasher.finalize())
}

pub fn room_topic_hash(code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vibe-room-v1");
    hasher.update(code.trim().to_uppercase().as_bytes());
    hex::encode(hasher.finalize())
}

/// Shared symmetric key for a contact pair (same bytes on both devices).
pub fn derive_session_key(local_peer_id: &[u8; 32], remote_peer_id: &[u8; 32]) -> [u8; 32] {
    let (a, b) = if local_peer_id < remote_peer_id {
        (local_peer_id, remote_peer_id)
    } else {
        (remote_peer_id, local_peer_id)
    };
    let mut hasher = Sha256::new();
    hasher.update(b"vibe-session-v1");
    hasher.update(a);
    hasher.update(b);
    hasher.finalize().into()
}

pub fn encrypt_message(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new_from_slice(key).map_err(|e| anyhow!("{e}"))?;
    let mut nonce_bytes = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| anyhow!("encrypt: {e}"))?;
    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub fn decrypt_message(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < 12 {
        return Err(anyhow!("ciphertext too short"));
    }
    let (nonce_bytes, ct) = blob.split_at(12);
    let cipher = ChaCha20Poly1305::new_from_slice(key).map_err(|e| anyhow!("{e}"))?;
    cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct)
        .map_err(|e| anyhow!("decrypt: {e}"))
}

pub fn ensure_session_key(
    identity: &Identity,
    store: &mut EphemeralStore,
    remote_peer_b64: &str,
) -> Result<[u8; 32]> {
    if let Some(key) = store.get_session_key(remote_peer_b64) {
        return Ok(key);
    }
    let local = *identity.verifying_key.as_bytes();
    let remote = Identity::peer_id_from_b64(remote_peer_b64)?;
    let key = derive_session_key(&local, &remote);
    store.set_session_key(remote_peer_b64, key);
    Ok(key)
}

pub fn encrypt_for_peer(
    identity: &Identity,
    store: &mut EphemeralStore,
    peer_id: &str,
    plaintext: &[u8],
) -> Result<String> {
    let key = ensure_session_key(identity, store, peer_id)?;
    let encrypted = encrypt_message(&key, plaintext)?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&encrypted))
}

pub fn decrypt_for_peer(
    identity: &Identity,
    store: &mut EphemeralStore,
    peer_id: &str,
    ciphertext_b64: &str,
) -> Result<Vec<u8>> {
    let ct = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(ciphertext_b64)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(ciphertext_b64))?;
    let key = ensure_session_key(identity, store, peer_id)?;
    match decrypt_message(&key, &ct) {
        Ok(plain) => Ok(plain),
        Err(_) => {
            // Drop stale keys from the old asymmetric derivation and retry once.
            store.remove_session_key(peer_id);
            let key = ensure_session_key(identity, store, peer_id)?;
            decrypt_message(&key, &ct)
        }
    }
}

pub fn build_wire_chat(
    identity: &Identity,
    store: &mut EphemeralStore,
    peer_id: &str,
    conversation_id: &str,
    body: &str,
) -> Result<(WireChat, Vec<u8>)> {
    let message_id = format!("{:016x}", rand::random::<u64>());
    let ciphertext = encrypt_for_peer(identity, store, peer_id, body.as_bytes())?;
    let sent_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let wire = WireChat {
        id: message_id,
        conversation_id: conversation_id.to_string(),
        sender_peer_id: identity.peer_id_b64(),
        ciphertext,
        sent_at,
    };
    let wire_bytes = serde_json::to_vec(&wire)?;
    Ok((wire, wire_bytes))
}

pub fn build_wire_chat_from_message(
    identity: &Identity,
    store: &mut EphemeralStore,
    msg: &MessageRow,
) -> Result<(WireChat, Vec<u8>)> {
    let ciphertext = encrypt_for_peer(identity, store, &msg.peer_id, msg.body.as_bytes())?;
    let wire = WireChat {
        id: msg.id.clone(),
        conversation_id: msg.conversation_id.clone(),
        sender_peer_id: identity.peer_id_b64(),
        ciphertext,
        sent_at: msg.sent_at,
    };
    let wire_bytes = serde_json::to_vec(&wire)?;
    Ok((wire, wire_bytes))
}

pub fn build_wire_ack(
    identity: &Identity,
    store: &mut EphemeralStore,
    sender_peer_id: &str,
    conversation_id: &str,
    message_id: &str,
) -> Result<Vec<u8>> {
    build_wire_receipt(identity, store, sender_peer_id, conversation_id, message_id)
}

pub fn build_wire_read(
    identity: &Identity,
    store: &mut EphemeralStore,
    sender_peer_id: &str,
    conversation_id: &str,
    message_id: &str,
) -> Result<Vec<u8>> {
    build_wire_receipt(identity, store, sender_peer_id, conversation_id, message_id)
}

fn build_wire_receipt(
    identity: &Identity,
    store: &mut EphemeralStore,
    sender_peer_id: &str,
    conversation_id: &str,
    message_id: &str,
) -> Result<Vec<u8>> {
    let payload = serde_json::json!({
        "messageId": message_id,
        "conversationId": conversation_id,
    });
    let plain = serde_json::to_vec(&payload)?;
    let ciphertext = encrypt_for_peer(identity, store, sender_peer_id, &plain)?;
    let wire = serde_json::json!({
        "senderPeerId": identity.peer_id_b64(),
        "ciphertext": ciphertext,
    });
    Ok(serde_json::to_vec(&wire)?)
}

pub fn ingest_wire_ack(
    identity: &Identity,
    store: &mut EphemeralStore,
    wire_bytes: &[u8],
    app: &AppHandle,
) -> Result<()> {
    let envelope: serde_json::Value = serde_json::from_slice(wire_bytes)?;
    let sender = envelope
        .get("senderPeerId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing senderPeerId"))?;
    let ciphertext = envelope
        .get("ciphertext")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing ciphertext"))?;
    if sender == identity.peer_id_b64() {
        return Ok(());
    }

    let plain = decrypt_for_peer(identity, store, sender, ciphertext)?;
    let ack: WireAck = serde_json::from_slice(&plain)?;

    let delivered_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    if store.mark_delivered(&sender, &ack.message_id) {
        let _ = app.emit(
            "message-ack",
            serde_json::json!({
                "peerId": sender,
                "messageId": ack.message_id,
                "conversationId": ack.conversation_id,
                "deliveredAt": delivered_at,
            }),
        );
    }
    Ok(())
}

pub fn ingest_wire_read(
    identity: &Identity,
    store: &mut EphemeralStore,
    wire_bytes: &[u8],
    app: &AppHandle,
) -> Result<()> {
    let envelope: serde_json::Value = serde_json::from_slice(wire_bytes)?;
    let sender = envelope
        .get("senderPeerId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing senderPeerId"))?;
    let ciphertext = envelope
        .get("ciphertext")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing ciphertext"))?;
    if sender == identity.peer_id_b64() {
        return Ok(());
    }

    let plain = decrypt_for_peer(identity, store, sender, ciphertext)?;
    let read: WireRead = serde_json::from_slice(&plain)?;

    let read_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    if store.mark_outgoing_read(&sender, &read.message_id) {
        let _ = app.emit(
            "message-read",
            serde_json::json!({
                "peerId": sender,
                "messageId": read.message_id,
                "conversationId": read.conversation_id,
                "readAt": read_at,
            }),
        );
    }
    Ok(())
}

pub fn ingest_wire_chat(
    identity: &Identity,
    store: &mut EphemeralStore,
    wire_bytes: &[u8],
    app: &AppHandle,
) -> Result<Option<MessageRow>> {
    let wire: WireChat = serde_json::from_slice(wire_bytes)?;
    if wire.sender_peer_id == identity.peer_id_b64() {
        return Ok(None);
    }

    let plain = decrypt_for_peer(identity, store, &wire.sender_peer_id, &wire.ciphertext)?;
    let body = String::from_utf8(plain)?;

    let msg = MessageRow {
        id: wire.id.clone(),
        conversation_id: wire.conversation_id.clone(),
        peer_id: wire.sender_peer_id.clone(),
        body: body.clone(),
        sent_at: wire.sent_at,
        outgoing: false,
        pending: false,
        delivered_at: None,
        read_at: None,
    };
    store.insert_message(&msg)?;
    let _ = app.emit(
        "message-received",
        serde_json::json!({
            "id": msg.id,
            "conversationId": msg.conversation_id,
            "peerId": msg.peer_id,
            "body": msg.body,
            "sentAt": msg.sent_at,
            "outgoing": false,
            "pending": false,
            "deliveredAt": null,
            "readAt": null,
        }),
    );
    Ok(Some(msg))
}

pub fn persist_outgoing_message(
    store: &mut EphemeralStore,
    peer_id: &str,
    conversation_id: &str,
    body: &str,
    sent_at: i64,
    message_id: &str,
    pending: bool,
) -> Result<MessageRow> {
    let msg = MessageRow {
        id: message_id.to_string(),
        conversation_id: conversation_id.to_string(),
        peer_id: peer_id.to_string(),
        body: body.to_string(),
        sent_at,
        outgoing: true,
        pending,
        delivered_at: None,
        read_at: None,
    };
    store.insert_message(&msg)?;
    Ok(msg)
}

