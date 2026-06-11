use std::path::Path;

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use ed25519_dalek::{SigningKey, VerifyingKey};
use libp2p::identity::Keypair;
use serde::{Deserialize, Serialize};

const KEY_FILE_JSON: &str = "identity.json";
const KEY_FILE_PROTO: &str = "identity.protobuf";
const BACKUP_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityBackup {
    pub version: u32,
    pub public_key: String,
    pub private_key: String,
}

pub struct Identity {
    signing_key: SigningKey,
    pub verifying_key: VerifyingKey,
    pub libp2p_keypair: Keypair,
}

impl Clone for Identity {
    fn clone(&self) -> Self {
        let sk_bytes = self.signing_key.to_bytes();
        let signing_key = SigningKey::from_bytes(&sk_bytes);
        Self {
            signing_key,
            verifying_key: self.verifying_key,
            libp2p_keypair: self.libp2p_keypair.clone(),
        }
    }
}

impl Identity {
    pub fn generate() -> Result<Self> {
        Self::from_libp2p_keypair(Keypair::generate_ed25519())
    }

    fn from_libp2p_keypair(libp2p_keypair: Keypair) -> Result<Self> {
        let ed = libp2p_keypair
            .clone()
            .try_into_ed25519()
            .map_err(|e| anyhow!("libp2p key: {e}"))?;
        let sk_bytes: [u8; 32] = ed
            .secret()
            .as_ref()
            .try_into()
            .map_err(|_| anyhow!("invalid secret key length"))?;
        let signing_key = SigningKey::from_bytes(&sk_bytes);
        let verifying_key = signing_key.verifying_key();
        Ok(Self {
            signing_key,
            verifying_key,
            libp2p_keypair,
        })
    }

    pub fn from_backup(json: &str) -> Result<Self> {
        let backup: IdentityBackup =
            serde_json::from_str(json).context("parse identity backup JSON")?;
        if backup.version != BACKUP_VERSION {
            return Err(anyhow!("unsupported backup version"));
        }
        let sk_bytes = decode_key_b64(&backup.private_key, "privateKey")?;
        let pk_bytes = decode_key_b64(&backup.public_key, "publicKey")?;
        let signing_key = SigningKey::from_bytes(&sk_bytes);
        let verifying_key = signing_key.verifying_key();
        if verifying_key.as_bytes() != &pk_bytes {
            return Err(anyhow!("privateKey does not match publicKey"));
        }
        let libp2p_keypair =
            Keypair::ed25519_from_bytes(sk_bytes).map_err(|e| anyhow!("libp2p key: {e}"))?;
        Ok(Self {
            signing_key,
            verifying_key,
            libp2p_keypair,
        })
    }

    pub fn load_or_create(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let json_path = data_dir.join(KEY_FILE_JSON);
        if json_path.exists() {
            let bytes = std::fs::read(&json_path).context("read identity.json")?;
            let backup: IdentityBackup =
                serde_json::from_slice(&bytes).context("parse identity.json")?;
            let identity = Self::from_backup(&serde_json::to_string(&backup)?)?;
            return Ok(identity);
        }

        let proto_path = data_dir.join(KEY_FILE_PROTO);
        if proto_path.exists() {
            let bytes = std::fs::read(&proto_path).context("read identity.protobuf")?;
            let libp2p_keypair =
                Keypair::from_protobuf_encoding(&bytes).context("decode identity.protobuf")?;
            let identity = Self::from_libp2p_keypair(libp2p_keypair)?;
            identity.save(data_dir)?;
            let _ = std::fs::remove_file(proto_path);
            return Ok(identity);
        }

        let identity = Self::generate()?;
        identity.save(data_dir)?;
        Ok(identity)
    }

    pub fn save(&self, data_dir: &Path) -> Result<()> {
        let json = self.to_backup_json()?;
        std::fs::write(data_dir.join(KEY_FILE_JSON), json)?;
        Ok(())
    }

    pub fn to_backup_json(&self) -> Result<String> {
        let backup = IdentityBackup {
            version: BACKUP_VERSION,
            public_key: self.peer_id_b64(),
            private_key: encode_key_b64(&self.signing_key.to_bytes()),
        };
        Ok(serde_json::to_string_pretty(&backup)?)
    }

    pub fn peer_id_b64(&self) -> String {
        encode_key_b64(self.verifying_key.as_bytes())
    }

    pub fn private_key_b64(&self) -> String {
        encode_key_b64(&self.signing_key.to_bytes())
    }

    pub fn peer_id_from_b64(s: &str) -> Result<[u8; 32]> {
        let bytes = decode_key_b64(s, "peer id")?;
        Ok(bytes)
    }

    fn from_legacy_protobuf(bytes: &[u8]) -> Result<Self> {
        let keypair =
            Keypair::from_protobuf_encoding(bytes).context("decode legacy identity.protobuf")?;
        Self::from_libp2p_keypair(keypair)
    }
}

fn encode_key_b64(bytes: impl AsRef<[u8]>) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes.as_ref())
}

fn decode_key_b64(s: &str, field: &str) -> Result<[u8; 32]> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s.trim())
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(s.trim()))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow!("{field} must be 32 bytes"))?;
    Ok(arr)
}
