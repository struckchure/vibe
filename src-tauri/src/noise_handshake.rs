//! In-memory Noise XX handshake state for data-channel transport.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use base64::Engine;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::crypto::install_noise_session_key;
use crate::noise_session::{NoiseInitiator, NoiseResponder};
use crate::store::EphemeralStore;

enum PendingHandshake {
    Initiator(NoiseInitiator),
    Responder(NoiseResponder),
}

pub struct NoiseHandshakeState {
    pending: Mutex<HashMap<String, PendingHandshake>>,
}

impl NoiseHandshakeState {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn clear_peer(&self, peer_id: &str) {
        self.pending.lock().remove(peer_id);
    }

    pub fn clear_all(&self) {
        self.pending.lock().clear();
    }
}

fn decode_b64(s: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s.trim())
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(s.trim()))
        .map_err(|e| anyhow!("invalid base64: {e}"))
}

fn encode_b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn handshake_start(state: &NoiseHandshakeState, peer_id: &str) -> Result<String> {
    if state.pending.lock().contains_key(peer_id) {
        state.pending.lock().remove(peer_id);
    }
    let mut initiator = NoiseInitiator::new()?;
    let m1 = initiator.write_message_1()?;
    let encoded = encode_b64(&m1);
    state
        .pending
        .lock()
        .insert(peer_id.to_string(), PendingHandshake::Initiator(initiator));
    Ok(encoded)
}

pub fn handshake_respond(
    state: &NoiseHandshakeState,
    peer_id: &str,
    message_b64: &str,
) -> Result<String> {
    let m1 = decode_b64(message_b64)?;
    let mut responder = NoiseResponder::new()?;
    let m2 = responder.read_message_1_write_message_2(&m1)?;
    let encoded = encode_b64(&m2);
    state
        .pending
        .lock()
        .insert(peer_id.to_string(), PendingHandshake::Responder(responder));
    Ok(encoded)
}

pub fn handshake_finish_initiator(
    state: &NoiseHandshakeState,
    store: &Arc<Mutex<EphemeralStore>>,
    app: &AppHandle,
    peer_id: &str,
    message_b64: &str,
) -> Result<String> {
    let m2 = decode_b64(message_b64)?;
    let pending = state
        .pending
        .lock()
        .remove(peer_id)
        .ok_or_else(|| anyhow!("no pending initiator handshake"))?;
    let PendingHandshake::Initiator(mut initiator) = pending else {
        return Err(anyhow!("expected initiator handshake state"));
    };
    let m3 = initiator.read_message_2_write_message_3(&m2)?;
    let key = initiator.finish()?;
    {
        let mut guard = store.lock();
        install_noise_session_key(&mut guard, peer_id, key);
    }
    let _ = app.emit(
        "noise-session-ready",
        serde_json::json!({ "peerId": peer_id }),
    );
    Ok(encode_b64(&m3))
}

pub fn handshake_finish_responder(
    state: &NoiseHandshakeState,
    store: &Arc<Mutex<EphemeralStore>>,
    app: &AppHandle,
    peer_id: &str,
    message_b64: &str,
) -> Result<()> {
    let m3 = decode_b64(message_b64)?;
    let pending = state
        .pending
        .lock()
        .remove(peer_id)
        .ok_or_else(|| anyhow!("no pending responder handshake"))?;
    let PendingHandshake::Responder(responder) = pending else {
        return Err(anyhow!("expected responder handshake state"));
    };
    let key = responder.finish(&m3)?;
    {
        let mut guard = store.lock();
        install_noise_session_key(&mut guard, peer_id, key);
    }
    let _ = app.emit(
        "noise-session-ready",
        serde_json::json!({ "peerId": peer_id }),
    );
    Ok(())
}
