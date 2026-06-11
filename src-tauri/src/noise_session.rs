//! Application-level Noise XX handshake (SPEC §9.3, §B.2).

use anyhow::Result;
use sha2::{Digest, Sha256};
use snow::{Builder, HandshakeState};

pub const NOISE_PATTERN: &str = "Noise_XX_25519_ChaChaPoly_SHA256";

pub fn derive_session_key_from_messages(m1: &[u8], m2: &[u8], m3: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"vibe-noise-session-v1");
    h.update(m1);
    h.update(m2);
    h.update(m3);
    h.finalize().into()
}

#[derive(Debug)]
pub struct NoiseInitiator {
    state: HandshakeState,
    m1: Vec<u8>,
    m2: Vec<u8>,
    m3: Vec<u8>,
}

#[derive(Debug)]
pub struct NoiseResponder {
    state: HandshakeState,
    m1: Vec<u8>,
    m2: Vec<u8>,
}

impl NoiseInitiator {
    pub fn new() -> Result<Self> {
        let params = NOISE_PATTERN.parse()?;
        let builder = Builder::new(params);
        let keypair = builder.generate_keypair()?;
        Ok(Self {
            state: builder
                .local_private_key(&keypair.private)
                .build_initiator()?,
            m1: Vec::new(),
            m2: Vec::new(),
            m3: Vec::new(),
        })
    }

    pub fn write_message_1(&mut self) -> Result<Vec<u8>> {
        let mut buf = vec![0u8; 65535];
        let n = self.state.write_message(&[], &mut buf)?;
        buf.truncate(n);
        self.m1 = buf.clone();
        Ok(buf)
    }

    pub fn read_message_2_write_message_3(&mut self, msg: &[u8]) -> Result<Vec<u8>> {
        self.m2 = msg.to_vec();
        let mut payload = vec![0u8; 65535];
        let n = self.state.read_message(msg, &mut payload)?;
        payload.truncate(n);
        let mut out = vec![0u8; 65535];
        let m = self.state.write_message(&payload, &mut out)?;
        out.truncate(m);
        self.m3 = out.clone();
        Ok(out)
    }

    pub fn finish(self) -> Result<[u8; 32]> {
        let _ = self.state.into_transport_mode()?;
        Ok(derive_session_key_from_messages(&self.m1, &self.m2, &self.m3))
    }
}

impl NoiseResponder {
    pub fn new() -> Result<Self> {
        let params = NOISE_PATTERN.parse()?;
        let builder = Builder::new(params);
        let keypair = builder.generate_keypair()?;
        Ok(Self {
            state: builder
                .local_private_key(&keypair.private)
                .build_responder()?,
            m1: Vec::new(),
            m2: Vec::new(),
        })
    }

    pub fn read_message_1_write_message_2(&mut self, msg: &[u8]) -> Result<Vec<u8>> {
        self.m1 = msg.to_vec();
        let mut payload = vec![0u8; 65535];
        let n = self.state.read_message(msg, &mut payload)?;
        payload.truncate(n);
        let mut out = vec![0u8; 65535];
        let m = self.state.write_message(&payload, &mut out)?;
        out.truncate(m);
        self.m2 = out.clone();
        Ok(out)
    }

    pub fn finish(mut self, m3: &[u8]) -> Result<[u8; 32]> {
        let mut buf = vec![0u8; 65535];
        self.state.read_message(m3, &mut buf)?;
        let _ = self.state.into_transport_mode()?;
        Ok(derive_session_key_from_messages(&self.m1, &self.m2, m3))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_xx_round_trip() {
        let mut initiator = NoiseInitiator::new().unwrap();
        let mut responder = NoiseResponder::new().unwrap();

        let m1 = initiator.write_message_1().unwrap();
        let m2 = responder.read_message_1_write_message_2(&m1).unwrap();
        let m3 = initiator.read_message_2_write_message_3(&m2).unwrap();

        let k1 = initiator.finish().unwrap();
        let k2 = responder.finish(&m3).unwrap();
        assert_eq!(k1, k2);
    }
}
