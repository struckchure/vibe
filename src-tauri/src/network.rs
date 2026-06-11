//! Minimal libp2p overlay: gossipsub + identify + inbound TCP only.
//! No mDNS, bootstrap, relay, rendezvous, or Kademlia.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use futures::StreamExt;
use libp2p::gossipsub::{self, IdentTopic, MessageAuthenticity, ValidationMode};
use libp2p::identify;
use libp2p::swarm::{NetworkBehaviour, SwarmEvent};
use libp2p::{noise, tcp, yamux, Multiaddr, PeerId, SwarmBuilder};
use parking_lot::{Mutex, RwLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::crypto;
use crate::identity::Identity;
use crate::store::EphemeralStore;

#[derive(NetworkBehaviour)]
struct Behaviour {
    gossipsub: gossipsub::Behaviour,
    identify: identify::Behaviour,
}

pub enum NetworkCommand {
    SubscribeConversation { conversation_id: String },
    PublishSignaling {
        conversation_id: String,
        payload: String,
        reply: Option<std::sync::mpsc::Sender<Result<(), String>>>,
    },
    DialAddrs { addrs: Vec<Multiaddr> },
}

pub struct NetworkHandle {
    cmd_tx: Mutex<Option<mpsc::UnboundedSender<NetworkCommand>>>,
    started: Arc<RwLock<bool>>,
    connected_libp2p_peers: Arc<RwLock<HashSet<PeerId>>>,
    app: AppHandle,
    store: Arc<Mutex<EphemeralStore>>,
}

impl NetworkHandle {
    pub fn new(identity: Arc<Identity>, store: Arc<Mutex<EphemeralStore>>, app: AppHandle) -> Self {
        let started = Arc::new(RwLock::new(false));
        let connected_libp2p_peers = Arc::new(RwLock::new(HashSet::new()));
        let cmd_tx = Mutex::new(None);

        let handle = Self {
            cmd_tx,
            started: started.clone(),
            connected_libp2p_peers: connected_libp2p_peers.clone(),
            app: app.clone(),
            store: store.clone(),
        };
        handle.spawn_swarm(identity, store, app, started, connected_libp2p_peers);
        handle
    }

    fn spawn_swarm(
        &self,
        identity: Arc<Identity>,
        store: Arc<Mutex<EphemeralStore>>,
        app: AppHandle,
        started: Arc<RwLock<bool>>,
        connected_libp2p_peers: Arc<RwLock<HashSet<PeerId>>>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        *self.cmd_tx.lock() = Some(tx);

        tauri::async_runtime::spawn(async move {
            if let Err(e) = run_swarm(identity, store, app, rx, started, connected_libp2p_peers).await
            {
                eprintln!("swarm error: {e}");
            }
        });
    }

    pub fn restart(&self, identity: Arc<Identity>) {
        *self.cmd_tx.lock() = None;
        *self.started.write() = false;
        self.connected_libp2p_peers.write().clear();
        self.spawn_swarm(
            identity,
            self.store.clone(),
            self.app.clone(),
            self.started.clone(),
            self.connected_libp2p_peers.clone(),
        );
    }

    fn sender(&self) -> Result<mpsc::UnboundedSender<NetworkCommand>> {
        self.cmd_tx
            .lock()
            .clone()
            .ok_or_else(|| anyhow!("network not running"))
    }

    pub fn start(&self) -> Result<()> {
        if *self.started.read() {
            return Ok(());
        }
        *self.started.write() = true;
        Ok(())
    }

    pub fn overlay_peer_count(&self) -> usize {
        self.connected_libp2p_peers.read().len()
    }

    pub fn is_peer_connected(&self, peer_id_b64: &str) -> bool {
        let Ok(pid) = libp2p_peer_id_from_contact(peer_id_b64) else {
            return false;
        };
        self.connected_libp2p_peers.read().contains(&pid)
    }

    pub fn subscribe_conversation(&self, conversation_id: &str) -> Result<()> {
        self.sender()?
            .send(NetworkCommand::SubscribeConversation {
                conversation_id: conversation_id.to_string(),
            })
            .map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }

    pub fn subscribe_all_contacts(&self) -> Result<()> {
        let contacts = self.store.lock().list_contacts();
        for c in contacts {
            self.subscribe_conversation(&c.conversation_id)?;
        }
        Ok(())
    }

    pub fn publish_signaling(&self, conversation_id: &str, payload: &str) -> Result<()> {
        if self.connected_libp2p_peers.read().is_empty() {
            return Err(anyhow!("no connected libp2p peers"));
        }
        let (tx, rx) = std::sync::mpsc::channel();
        self.sender()?
            .send(NetworkCommand::PublishSignaling {
                conversation_id: conversation_id.to_string(),
                payload: payload.to_string(),
                reply: Some(tx),
            })
            .map_err(|e| anyhow!("{e}"))?;
        match rx.recv() {
            Ok(result) => result.map_err(|e| anyhow!("{e}")),
            Err(_) => Err(anyhow!("network stopped")),
        }
    }

    pub fn publish_signaling_best_effort(&self, conversation_id: &str, payload: &str) -> Result<()> {
        if self.connected_libp2p_peers.read().is_empty() {
            return Err(anyhow!("no connected libp2p peers"));
        }
        self.sender()?
            .send(NetworkCommand::PublishSignaling {
                conversation_id: conversation_id.to_string(),
                payload: payload.to_string(),
                reply: None,
            })
            .map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }

    pub fn dial_addrs(&self, addrs: &[String]) -> Result<()> {
        let mut parsed = Vec::new();
        for s in addrs {
            let addr: Multiaddr = s.parse().map_err(|e| anyhow!("invalid multiaddr {s}: {e}"))?;
            parsed.push(addr);
        }
        if parsed.is_empty() {
            return Err(anyhow!("no dial addresses"));
        }
        self.sender()?
            .send(NetworkCommand::DialAddrs { addrs: parsed })
            .map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }
}

pub fn libp2p_peer_id_from_contact(peer_id_b64: &str) -> Result<PeerId> {
    let bytes = Identity::peer_id_from_b64(peer_id_b64)?;
    let ed_pk = libp2p::identity::ed25519::PublicKey::try_from_bytes(&bytes)
        .map_err(|e| anyhow!("invalid peer key: {e}"))?;
    Ok(libp2p::identity::PublicKey::from(ed_pk).to_peer_id())
}

fn emit_overlay_peer_count(app: &AppHandle, count: usize) {
    let _ = app.emit("overlay-peers-changed", count);
}

async fn run_swarm(
    identity: Arc<Identity>,
    _store: Arc<Mutex<EphemeralStore>>,
    app: AppHandle,
    mut rx: mpsc::UnboundedReceiver<NetworkCommand>,
    _started: Arc<RwLock<bool>>,
    connected_libp2p_peers: Arc<RwLock<HashSet<PeerId>>>,
) -> Result<()> {
    let local_key = identity.libp2p_keypair.clone();
    let local_peer_id = local_key.public().to_peer_id();

    let gossipsub_config = gossipsub::ConfigBuilder::default()
        .validation_mode(ValidationMode::Permissive)
        .mesh_n(1)
        .mesh_n_low(0)
        .mesh_n_high(2)
        .mesh_outbound_min(0)
        .flood_publish(true)
        .heartbeat_initial_delay(Duration::from_millis(500))
        .heartbeat_interval(Duration::from_millis(500))
        .build()
        .map_err(|e| anyhow!("{e}"))?;

    let gossipsub = gossipsub::Behaviour::new(
        MessageAuthenticity::Signed(local_key.clone()),
        gossipsub_config,
    )
    .map_err(|e| anyhow!("{e}"))?;

    let identify = identify::Behaviour::new(identify::Config::new(
        "vibe/0.1.0".to_string(),
        local_key.public(),
    ));

    let mut swarm = SwarmBuilder::with_existing_identity(local_key)
        .with_tokio()
        .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)?
        .with_behaviour(|_| Behaviour {
            gossipsub,
            identify,
        })?
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
        .build();

    swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse()?)?;

    let mut subscribed_conversations: HashSet<String> = HashSet::new();

    loop {
        tokio::select! {
            event = swarm.select_next_some() => {
                match event {
                    SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                        if peer_id != local_peer_id {
                            swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                            let mut peers = connected_libp2p_peers.write();
                            if peers.insert(peer_id) {
                                emit_overlay_peer_count(&app, peers.len());
                            }
                        }
                    }
                    SwarmEvent::ConnectionClosed { peer_id, .. } => {
                        if peer_id != local_peer_id {
                            let mut peers = connected_libp2p_peers.write();
                            if peers.remove(&peer_id) {
                                emit_overlay_peer_count(&app, peers.len());
                            }
                        }
                    }
                    SwarmEvent::Behaviour(behaviour_event) => {
                        handle_behaviour_event(
                            behaviour_event,
                            &identity,
                            &app,
                            &mut swarm,
                            &mut subscribed_conversations,
                        );
                    }
                    _ => {}
                }
            }
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break };
                match cmd {
                    NetworkCommand::SubscribeConversation { conversation_id } => {
                        subscribe_signal_topic(&mut swarm, &mut subscribed_conversations, &conversation_id);
                    }
                    NetworkCommand::PublishSignaling { conversation_id, payload, reply } => {
                        subscribe_signal_topic(&mut swarm, &mut subscribed_conversations, &conversation_id);
                        let topic = IdentTopic::new(format!("vibe/signal/{conversation_id}"));
                        let result = if connected_libp2p_peers.read().is_empty() {
                            Err("no connected libp2p peers".to_string())
                        } else {
                            swarm
                                .behaviour_mut()
                                .gossipsub
                                .publish(topic, payload.as_bytes())
                                .map(|_| ())
                                .map_err(|e| e.to_string())
                        };
                        if let Some(tx) = reply {
                            let _ = tx.send(result);
                        } else if let Err(ref e) = result {
                            eprintln!("publish signaling: {e}");
                        }
                    }
                    NetworkCommand::DialAddrs { addrs } => {
                        for addr in addrs {
                            if let Err(e) = swarm.dial(addr) {
                                eprintln!("dial: {e}");
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

fn subscribe_signal_topic(
    swarm: &mut libp2p::Swarm<Behaviour>,
    subscribed: &mut HashSet<String>,
    conversation_id: &str,
) {
    if !subscribed.insert(conversation_id.to_string()) {
        return;
    }
    let signal = IdentTopic::new(format!("vibe/signal/{conversation_id}"));
    if let Err(e) = swarm.behaviour_mut().gossipsub.subscribe(&signal) {
        eprintln!("subscribe signal topic: {e}");
    }
}

fn handle_behaviour_event(
    event: BehaviourEvent,
    identity: &Identity,
    app: &AppHandle,
    _swarm: &mut libp2p::Swarm<Behaviour>,
    _subscribed: &mut HashSet<String>,
) {
    use gossipsub::Event as GossipEvent;

    let BehaviourEvent::Gossipsub(GossipEvent::Message { message, .. }) = event else {
        return;
    };

    let topic = message.topic.as_str();
    if !topic.starts_with("vibe/signal/") {
        return;
    }

    let conv = topic.strip_prefix("vibe/signal/").unwrap_or("");
    let raw = String::from_utf8_lossy(&message.data).to_string();
    if let Some(payload) = crypto::signal_wire_emit_payload(identity, &raw) {
        let _ = app.emit(
            "signaling",
            serde_json::json!({
                "conversationId": conv,
                "payload": payload,
            }),
        );
    }
}

