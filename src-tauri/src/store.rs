use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CONTACTS_FILE: &str = "contacts.json";
const CONTACTS_VERSION: u32 = 1;
const MESSAGES_DIR: &str = "messages";
const MESSAGES_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactRow {
    pub peer_id: String,
    pub display_name: String,
    pub conversation_id: String,
    pub last_message: Option<String>,
    pub last_message_at: Option<i64>,
    #[serde(default)]
    pub unread_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: String,
    pub conversation_id: String,
    pub peer_id: String,
    pub body: String,
    pub sent_at: i64,
    pub outgoing: bool,
    #[serde(default)]
    pub pending: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<i64>,
    #[serde(default = "default_message_kind")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_media: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_duration_ms: Option<i64>,
}

fn default_message_kind() -> String {
    "text".to_string()
}

#[derive(Debug, Clone)]
pub struct PendingOutbound {
    pub peer_id: String,
    pub message: MessageRow,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContactsFile {
    version: u32,
    contacts: Vec<ContactRow>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagesFile {
    version: u32,
    peer_id: String,
    messages: Vec<MessageRow>,
}

/// Contacts and chat history persist under the app data directory.
pub struct EphemeralStore {
    contacts_path: PathBuf,
    messages_dir: PathBuf,
    contacts: HashMap<String, ContactRow>,
    messages: HashMap<String, Vec<MessageRow>>,
    session_keys: HashMap<String, [u8; 32]>,
}

impl EphemeralStore {
    pub fn load(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let messages_dir = data_dir.join(MESSAGES_DIR);
        std::fs::create_dir_all(&messages_dir)?;

        let contacts_path = data_dir.join(CONTACTS_FILE);
        let contacts = if contacts_path.exists() {
            let bytes = std::fs::read(&contacts_path).context("read contacts.json")?;
            let file: ContactsFile = serde_json::from_slice(&bytes).context("parse contacts.json")?;
            if file.version != CONTACTS_VERSION {
                return Err(anyhow!("unsupported contacts file version"));
            }
            file.contacts
                .into_iter()
                .map(|c| (c.peer_id.clone(), c))
                .collect()
        } else {
            HashMap::new()
        };

        let messages = Self::load_all_messages(&messages_dir)?;

        Ok(Self {
            contacts_path,
            messages_dir,
            contacts,
            messages,
            session_keys: HashMap::new(),
        })
    }

    fn load_all_messages(messages_dir: &Path) -> Result<HashMap<String, Vec<MessageRow>>> {
        let mut out = HashMap::new();
        let entries = match std::fs::read_dir(messages_dir) {
            Ok(e) => e,
            Err(_) => return Ok(out),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let file: MessagesFile = match serde_json::from_slice(&bytes) {
                Ok(f) => f,
                Err(_) => continue,
            };
            if file.version != MESSAGES_VERSION {
                continue;
            }
            out.insert(file.peer_id, file.messages);
        }
        Ok(out)
    }

    fn message_path(&self, peer_id: &str) -> PathBuf {
        self.messages_dir.join(format!("{}.json", peer_file_id(peer_id)))
    }

    fn save_messages(&self, peer_id: &str) -> Result<()> {
        let list = self
            .messages
            .get(peer_id)
            .cloned()
            .unwrap_or_default();
        let file = MessagesFile {
            version: MESSAGES_VERSION,
            peer_id: peer_id.to_string(),
            messages: list,
        };
        let json = serde_json::to_string_pretty(&file)?;
        std::fs::write(self.message_path(peer_id), json)?;
        Ok(())
    }

    pub fn clear(&mut self) -> Result<()> {
        self.contacts.clear();
        self.messages.clear();
        self.session_keys.clear();
        if self.messages_dir.exists() {
            for entry in std::fs::read_dir(&self.messages_dir)?.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        self.save_contacts()
    }

    pub fn add_contact(
        &mut self,
        peer_id: &str,
        display_name: &str,
        conversation_id: &str,
    ) -> Result<ContactRow> {
        let row = ContactRow {
            peer_id: peer_id.to_string(),
            display_name: display_name.to_string(),
            conversation_id: conversation_id.to_string(),
            last_message: None,
            last_message_at: None,
            unread_count: 0,
        };
        self.contacts.insert(peer_id.to_string(), row.clone());
        self.messages.entry(peer_id.to_string()).or_default();
        self.save_contacts()?;
        self.save_messages(peer_id)?;
        Ok(row)
    }

    pub fn get_contact(&self, peer_id: &str) -> Result<ContactRow> {
        self.contacts
            .get(peer_id)
            .cloned()
            .ok_or_else(|| anyhow!("contact not found"))
    }

    pub fn list_contacts(&self) -> Vec<ContactRow> {
        let mut rows: Vec<_> = self
            .contacts
            .values()
            .map(|c| {
                let mut row = c.clone();
                row.unread_count = self.unread_count(&c.peer_id);
                row
            })
            .collect();
        rows.sort_by(|a, b| {
            b.last_message_at
                .unwrap_or(0)
                .cmp(&a.last_message_at.unwrap_or(0))
        });
        rows
    }

    pub fn unread_count(&self, peer_id: &str) -> u32 {
        self.messages
            .get(peer_id)
            .map(|list| {
                list.iter()
                    .filter(|m| !m.outgoing && m.read_at.is_none())
                    .count() as u32
            })
            .unwrap_or(0)
    }

    pub fn mark_incoming_read(&mut self, peer_id: &str) -> Vec<String> {
        let Some(list) = self.messages.get_mut(peer_id) else {
            return Vec::new();
        };
        let now = Self::now_ms();
        let mut ids = Vec::new();
        for msg in list.iter_mut() {
            if !msg.outgoing && msg.read_at.is_none() && msg.kind != "call" {
                msg.read_at = Some(now);
                ids.push(msg.id.clone());
            }
        }
        if !ids.is_empty() {
            let _ = self.save_messages(peer_id);
        }
        ids
    }

    pub fn mark_outgoing_read(&mut self, peer_id: &str, message_id: &str) -> bool {
        self.update_message(peer_id, message_id, |msg| {
            if msg.read_at.is_none() {
                msg.read_at = Some(Self::now_ms());
            }
        })
    }

    pub fn remove_contact(&mut self, peer_id: &str) -> Result<()> {
        if self.contacts.remove(peer_id).is_none() {
            return Err(anyhow!("contact not found"));
        }
        self.messages.remove(peer_id);
        self.session_keys.remove(peer_id);
        let path = self.message_path(peer_id);
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
        self.save_contacts()
    }

    pub fn insert_message(&mut self, msg: &MessageRow) -> Result<()> {
        let list = self.messages.entry(msg.peer_id.clone()).or_default();
        if let Some(existing) = list.iter_mut().find(|m| m.id == msg.id) {
            *existing = msg.clone();
        } else {
            list.push(msg.clone());
        }
        if let Some(contact) = self.contacts.get_mut(&msg.peer_id) {
            contact.last_message = Some(msg.body.clone());
            contact.last_message_at = Some(msg.sent_at);
            self.save_contacts()?;
        }
        self.save_messages(&msg.peer_id)
    }

    pub fn list_messages(&self, peer_id: &str) -> Vec<MessageRow> {
        let mut list = self.messages.get(peer_id).cloned().unwrap_or_default();
        list.sort_by_key(|m| m.sent_at);
        list
    }

    pub fn insert_call_history(
        &mut self,
        peer_id: &str,
        conversation_id: &str,
        outgoing: bool,
        media: &str,
        outcome: &str,
        duration_ms: Option<i64>,
    ) -> Result<MessageRow> {
        let body = format_call_body(outgoing, media, outcome, duration_ms);
        let msg = MessageRow {
            id: format!("call-{:016x}", rand::random::<u64>()),
            conversation_id: conversation_id.to_string(),
            peer_id: peer_id.to_string(),
            body,
            sent_at: Self::now_ms(),
            outgoing,
            pending: false,
            delivered_at: None,
            read_at: None,
            kind: "call".to_string(),
            call_media: Some(media.to_string()),
            call_outcome: Some(outcome.to_string()),
            call_duration_ms: duration_ms,
        };
        self.insert_message(&msg)?;
        Ok(msg)
    }

    pub fn list_pending_outgoing(&self) -> Vec<PendingOutbound> {
        let mut out = Vec::new();
        for (peer_id, list) in &self.messages {
            for msg in list {
                if msg.outgoing && msg.pending {
                    out.push(PendingOutbound {
                        peer_id: peer_id.clone(),
                        message: msg.clone(),
                    });
                }
            }
        }
        out.sort_by(|a, b| a.message.sent_at.cmp(&b.message.sent_at));
        out
    }

    pub fn mark_outgoing_sent(&mut self, peer_id: &str, message_id: &str) -> bool {
        self.update_message(peer_id, message_id, |msg| {
            msg.pending = false;
        })
    }

    pub fn mark_delivered(&mut self, peer_id: &str, message_id: &str) -> bool {
        self.update_message(peer_id, message_id, |msg| {
            if msg.delivered_at.is_none() {
                msg.delivered_at = Some(Self::now_ms());
            }
            msg.pending = false;
        })
    }

    fn update_message<F>(&mut self, peer_id: &str, message_id: &str, f: F) -> bool
    where
        F: FnOnce(&mut MessageRow),
    {
        let Some(list) = self.messages.get_mut(peer_id) else {
            return false;
        };
        for msg in list.iter_mut() {
            if msg.id == message_id {
                f(msg);
                let _ = self.save_messages(peer_id);
                return true;
            }
        }
        false
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    }

    pub fn get_session_key(&self, peer_id: &str) -> Option<[u8; 32]> {
        self.session_keys.get(peer_id).copied()
    }

    pub fn set_session_key(&mut self, peer_id: &str, key: [u8; 32]) {
        self.session_keys.insert(peer_id.to_string(), key);
    }

    pub fn remove_session_key(&mut self, peer_id: &str) {
        self.session_keys.remove(peer_id);
    }

    fn save_contacts(&self) -> Result<()> {
        let mut contacts: Vec<_> = self.contacts.values().cloned().collect();
        contacts.sort_by(|a, b| a.peer_id.cmp(&b.peer_id));
        let file = ContactsFile {
            version: CONTACTS_VERSION,
            contacts,
        };
        let json = serde_json::to_string_pretty(&file)?;
        std::fs::write(&self.contacts_path, json)?;
        Ok(())
    }
}

fn format_call_duration(duration_ms: i64) -> String {
    let total_sec = (duration_ms.max(0) / 1000) as u64;
    let mins = total_sec / 60;
    let secs = total_sec % 60;
    if mins > 0 {
        format!("{mins}:{secs:02}")
    } else {
        format!("{secs}s")
    }
}

fn format_call_body(
    outgoing: bool,
    media: &str,
    outcome: &str,
    duration_ms: Option<i64>,
) -> String {
    let label = if media == "video" {
        "Video call"
    } else {
        "Voice call"
    };
    match outcome {
        "completed" => {
            let dur = duration_ms
                .filter(|d| *d > 0)
                .map(format_call_duration)
                .unwrap_or_else(|| "0s".to_string());
            if outgoing {
                format!("Outgoing {label} · {dur}")
            } else {
                format!("{label} · {dur}")
            }
        }
        "missed" => {
            if outgoing {
                format!("Missed {label}")
            } else {
                format!("Missed incoming {label}")
            }
        }
        "declined" => {
            if outgoing {
                format!("{label} · Declined")
            } else {
                format!("Declined incoming {label}")
            }
        }
        "cancelled" => format!("{label} · Cancelled"),
        _ => label.to_string(),
    }
}

fn peer_file_id(peer_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vibe-msg-file-v1");
    hasher.update(peer_id.as_bytes());
    hex::encode(&hasher.finalize()[..16])
}
