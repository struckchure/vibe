use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use base64::Engine;
use futures::StreamExt;
use libp2p::gossipsub::{self, IdentTopic, MessageAuthenticity, ValidationMode};
use libp2p::identify;
use libp2p::mdns;
use libp2p::request_response::{self, ProtocolSupport};
use libp2p::swarm::{NetworkBehaviour, StreamProtocol, SwarmEvent};
use libp2p::{multiaddr::Protocol, noise, tcp, yamux, Multiaddr, PeerId, SwarmBuilder};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::crypto::{self, room_topic_hash};
use crate::identity::Identity;
use crate::store::EphemeralStore;

const ROOM_ANNOUNCE_PROTOCOL: &str = "/vibe/room-announce/1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomPeer {
    pub peer_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAnnounce {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub peer_id: String,
    pub display_name: String,
    pub expires_at: i64,
    #[serde(default)]
    pub listen_addrs: Vec<String>,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RoomAnnounceReq(WireAnnounce);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RoomAnnounceResp {
    ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRoomEvent {
    #[serde(rename = "type")]
    msg_type: String,
    peer_id: String,
    display_name: String,
    at: i64,
    signature: String,
}

#[derive(NetworkBehaviour)]
struct Behaviour {
    gossipsub: gossipsub::Behaviour,
    mdns: mdns::tokio::Behaviour,
    identify: identify::Behaviour,
    room_announce: request_response::json::Behaviour<RoomAnnounceReq, RoomAnnounceResp>,
}

pub enum NetworkCommand {
    JoinRoom {
        code: String,
        display_name: String,
    },
    LeaveRoom,
    SubscribeConversation { conversation_id: String },
    PublishSignaling {
        conversation_id: String,
        payload: String,
        reply: Option<std::sync::mpsc::Sender<Result<(), String>>>,
    },
    PublishMessage {
        conversation_id: String,
        wire: Vec<u8>,
    },
    PublishAck {
        conversation_id: String,
        sender_peer_id: String,
        message_id: String,
    },
    PublishRead {
        conversation_id: String,
        sender_peer_id: String,
        message_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomStatus {
    pub in_room: bool,
    pub code: Option<String>,
}

pub struct NetworkHandle {
    cmd_tx: Mutex<Option<mpsc::UnboundedSender<NetworkCommand>>>,
    room_peers: Arc<RwLock<HashMap<String, RoomPeer>>>,
    current_room: Arc<RwLock<Option<String>>>,
    display_name: Arc<RwLock<String>>,
    started: Arc<RwLock<bool>>,
    connected_libp2p_peers: Arc<RwLock<HashSet<PeerId>>>,
    app: AppHandle,
    store: Arc<Mutex<EphemeralStore>>,
}

impl NetworkHandle {
    pub fn new(identity: Arc<Identity>, store: Arc<Mutex<EphemeralStore>>, app: AppHandle) -> Self {
        let room_peers = Arc::new(RwLock::new(HashMap::new()));
        let current_room = Arc::new(RwLock::new(None));
        let display_name = Arc::new(RwLock::new("Peer".to_string()));
        let started = Arc::new(RwLock::new(false));
        let connected_libp2p_peers = Arc::new(RwLock::new(HashSet::new()));
        let cmd_tx = Mutex::new(None);

        let handle = Self {
            cmd_tx,
            room_peers: room_peers.clone(),
            current_room: current_room.clone(),
            display_name: display_name.clone(),
            started: started.clone(),
            connected_libp2p_peers: connected_libp2p_peers.clone(),
            app: app.clone(),
            store: store.clone(),
        };
        handle.spawn_swarm(
            identity,
            store,
            app,
            room_peers,
            current_room,
            display_name,
            started,
            connected_libp2p_peers,
        );
        handle
    }

    fn spawn_swarm(
        &self,
        identity: Arc<Identity>,
        store: Arc<Mutex<EphemeralStore>>,
        app: AppHandle,
        room_peers: Arc<RwLock<HashMap<String, RoomPeer>>>,
        current_room: Arc<RwLock<Option<String>>>,
        display_name: Arc<RwLock<String>>,
        started: Arc<RwLock<bool>>,
        connected_libp2p_peers: Arc<RwLock<HashSet<PeerId>>>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        *self.cmd_tx.lock() = Some(tx);

        tauri::async_runtime::spawn(async move {
            if let Err(e) = run_swarm(
                identity,
                store,
                app,
                rx,
                room_peers,
                current_room,
                display_name,
                started,
                connected_libp2p_peers,
            )
            .await
            {
                eprintln!("swarm error: {e}");
            }
        });
    }

    pub fn restart(&self, identity: Arc<Identity>) {
        *self.cmd_tx.lock() = None;
        self.room_peers.write().clear();
        *self.current_room.write() = None;
        *self.started.write() = false;
        self.connected_libp2p_peers.write().clear();
        self.spawn_swarm(
            identity,
            self.store.clone(),
            self.app.clone(),
            self.room_peers.clone(),
            self.current_room.clone(),
            self.display_name.clone(),
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

    pub fn room_status(&self) -> RoomStatus {
        let code = self.current_room.read().clone();
        RoomStatus {
            in_room: code.is_some(),
            code,
        }
    }

    pub fn join_room(&self, code: &str, display_name: &str) -> Result<()> {
        let code = code.trim();
        if code.is_empty() {
            return Err(anyhow!("room code is empty"));
        }
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err(anyhow!("display name is required"));
        }
        *self.display_name.write() = display_name.to_string();
        if self.current_room.read().as_deref() == Some(code) {
            return Ok(());
        }
        self.sender()?
            .send(NetworkCommand::JoinRoom {
                code: code.to_string(),
                display_name: display_name.to_string(),
            })
            .map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }

    pub fn publish_ack(
        &self,
        conversation_id: &str,
        sender_peer_id: &str,
        message_id: &str,
    ) -> Result<()> {
        self.sender()?
            .send(NetworkCommand::PublishAck {
                conversation_id: conversation_id.to_string(),
                sender_peer_id: sender_peer_id.to_string(),
                message_id: message_id.to_string(),
            })
            .map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }

    pub fn publish_read(
        &self,
        conversation_id: &str,
        sender_peer_id: &str,
        message_id: &str,
    ) -> Result<()> {
        self.sender()?
            .send(NetworkCommand::PublishRead {
                conversation_id: conversation_id.to_string(),
                sender_peer_id: sender_peer_id.to_string(),
                message_id: message_id.to_string(),
            })
            .map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }

    pub fn leave_room(&self) -> Result<()> {
        self.room_peers.write().clear();
        *self.current_room.write() = None;
        self.sender()?
            .send(NetworkCommand::LeaveRoom)
            .map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }

    pub fn list_room_peers(&self) -> Vec<RoomPeer> {
        self.room_peers.read().values().cloned().collect()
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
        self.sender()?
            .send(NetworkCommand::PublishSignaling {
                conversation_id: conversation_id.to_string(),
                payload: payload.to_string(),
                reply: None,
            })
            .map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }

    pub fn publish_message(&self, conversation_id: &str, wire: Vec<u8>) -> Result<()> {
        self.sender()?
            .send(NetworkCommand::PublishMessage {
                conversation_id: conversation_id.to_string(),
                wire,
            })
            .map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }
}

async fn run_swarm(
    identity: Arc<Identity>,
    store: Arc<Mutex<EphemeralStore>>,
    app: AppHandle,
    mut rx: mpsc::UnboundedReceiver<NetworkCommand>,
    room_peers: Arc<RwLock<HashMap<String, RoomPeer>>>,
    current_room: Arc<RwLock<Option<String>>>,
    display_name: Arc<RwLock<String>>,
    started: Arc<RwLock<bool>>,
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

    let mdns_behaviour =
        mdns::tokio::Behaviour::new(mdns::Config::default(), local_peer_id).map_err(|e| anyhow!("{e}"))?;

    let identify = identify::Behaviour::new(identify::Config::new(
        "vibe/0.1.0".to_string(),
        local_key.public(),
    ));

    let room_announce = request_response::json::Behaviour::<RoomAnnounceReq, RoomAnnounceResp>::new(
        [(
            StreamProtocol::new(ROOM_ANNOUNCE_PROTOCOL),
            ProtocolSupport::Full,
        )],
        request_response::Config::default(),
    );

    let behaviour = Behaviour {
        gossipsub,
        mdns: mdns_behaviour,
        identify,
        room_announce,
    };

    let mut swarm = SwarmBuilder::with_existing_identity(local_key)
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_behaviour(|_| behaviour)?
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
        .build();

    swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse()?)?;

    let mut announce_interval = tokio::time::interval(Duration::from_secs(5));
    let mut room_topic: Option<IdentTopic> = None;
    let mut presence_topic: Option<IdentTopic> = None;
    let mut listen_addrs: Vec<Multiaddr> = Vec::new();
    let mut subscribed_conversations: HashSet<String> = HashSet::new();
    let mut announced_room_to: HashSet<PeerId> = HashSet::new();

    loop {
        tokio::select! {
            event = swarm.select_next_some() => {
                match event {
                    SwarmEvent::NewListenAddr { address, .. } => {
                        if !listen_addrs.contains(&address) {
                            listen_addrs.push(address);
                        }
                    }
                    SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                        if peer_id != local_peer_id {
                            swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                            let mut peers = connected_libp2p_peers.write();
                            if peers.insert(peer_id) {
                                emit_overlay_peer_count(&app, peers.len());
                            }
                            drop(peers);

                            if room_topic.is_some() && announced_room_to.insert(peer_id) {
                                let name = display_name.read().clone();
                                push_room_announce_direct(
                                    &mut swarm,
                                    &identity,
                                    &name,
                                    &listen_addrs,
                                    peer_id,
                                );
                            }
                        }
                    }
                    SwarmEvent::ConnectionClosed { peer_id, .. } => {
                        if peer_id != local_peer_id {
                            announced_room_to.remove(&peer_id);
                            let mut peers = connected_libp2p_peers.write();
                            if peers.remove(&peer_id) {
                                emit_overlay_peer_count(&app, peers.len());
                            }
                        }
                    }
                    SwarmEvent::Behaviour(behaviour_event) => {
                        if let Some(addrs) = handle_behaviour_event(
                            behaviour_event,
                            &identity,
                            &store,
                            &app,
                            &room_peers,
                            &mut swarm,
                            &mut subscribed_conversations,
                        ) {
                            dial_addrs(&mut swarm, addrs);
                        }
                    }
                    _ => {}
                }
            }
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break };
                match cmd {
                    NetworkCommand::JoinRoom {
                        code,
                        display_name: join_name,
                    } => {
                        *display_name.write() = join_name.clone();
                        if current_room.read().as_deref() == Some(code.as_str())
                            && room_topic.is_some()
                        {
                            publish_room_presence(
                                &mut swarm,
                                &identity,
                                &join_name,
                                &code,
                                "vibe/room/join/2",
                            );
                            continue;
                        }
                        if let Some(t) = room_topic.take() {
                            let _ = swarm.behaviour_mut().gossipsub.unsubscribe(&t);
                        }
                        if let Some(t) = presence_topic.take() {
                            let _ = swarm.behaviour_mut().gossipsub.unsubscribe(&t);
                        }
                        announced_room_to.clear();
                        let hash = room_topic_hash(&code);
                        let topic = IdentTopic::new(format!("vibe/room/{hash}"));
                        let presence = IdentTopic::new(format!("vibe/room/{hash}/presence"));
                        if let Err(e) = swarm.behaviour_mut().gossipsub.subscribe(&topic) {
                            eprintln!("subscribe room topic: {e}");
                        }
                        if let Err(e) = swarm.behaviour_mut().gossipsub.subscribe(&presence) {
                            eprintln!("subscribe presence topic: {e}");
                        }
                        room_topic = Some(topic);
                        presence_topic = Some(presence);
                        *current_room.write() = Some(code.clone());
                        room_peers.write().clear();
                        publish_room_presence(
                            &mut swarm,
                            &identity,
                            &join_name,
                            &code,
                            "vibe/room/join/2",
                        );
                    }
                    NetworkCommand::LeaveRoom => {
                        if let Some(code) = current_room.read().clone() {
                            let name = display_name.read().clone();
                            publish_room_presence(
                                &mut swarm,
                                &identity,
                                &name,
                                &code,
                                "vibe/room/leave/2",
                            );
                        }
                        if let Some(t) = room_topic.take() {
                            let _ = swarm.behaviour_mut().gossipsub.unsubscribe(&t);
                        }
                        if let Some(t) = presence_topic.take() {
                            let _ = swarm.behaviour_mut().gossipsub.unsubscribe(&t);
                        }
                        *current_room.write() = None;
                        room_peers.write().clear();
                        announced_room_to.clear();
                    }
                    NetworkCommand::SubscribeConversation { conversation_id } => {
                        subscribe_conversation_topics(
                            &mut swarm,
                            &mut subscribed_conversations,
                            &conversation_id,
                        );
                    }
                    NetworkCommand::PublishSignaling {
                        conversation_id,
                        payload,
                        reply,
                    } => {
                        subscribe_conversation_topics(
                            &mut swarm,
                            &mut subscribed_conversations,
                            &conversation_id,
                        );
                        let topic = IdentTopic::new(format!("vibe/signal/{conversation_id}"));
                        let result = swarm
                            .behaviour_mut()
                            .gossipsub
                            .publish(topic, payload.as_bytes())
                            .map(|_| ())
                            .map_err(|e| e.to_string());
                        if let Some(tx) = reply {
                            let _ = tx.send(result);
                        } else if let Err(ref e) = result {
                            eprintln!("publish signaling: {e}");
                        }
                    }
                    NetworkCommand::PublishMessage { conversation_id, wire } => {
                        subscribe_conversation_topics(
                            &mut swarm,
                            &mut subscribed_conversations,
                            &conversation_id,
                        );
                        let topic = IdentTopic::new(format!("vibe/msg/{conversation_id}"));
                        if let Err(e) = swarm.behaviour_mut().gossipsub.publish(topic, wire) {
                            eprintln!("publish message: {e}");
                        }
                    }
                    NetworkCommand::PublishAck {
                        conversation_id,
                        sender_peer_id,
                        message_id,
                    } => {
                        subscribe_conversation_topics(
                            &mut swarm,
                            &mut subscribed_conversations,
                            &conversation_id,
                        );
                        let mut guard = store.lock();
                        match crypto::build_wire_ack(
                            &identity,
                            &mut guard,
                            &sender_peer_id,
                            &conversation_id,
                            &message_id,
                        ) {
                            Ok(wire) => {
                                let topic =
                                    IdentTopic::new(format!("vibe/ack/{conversation_id}"));
                                if let Err(e) =
                                    swarm.behaviour_mut().gossipsub.publish(topic, wire)
                                {
                                    eprintln!("publish ack: {e}");
                                }
                            }
                            Err(e) => eprintln!("build ack: {e}"),
                        }
                    }
                    NetworkCommand::PublishRead {
                        conversation_id,
                        sender_peer_id,
                        message_id,
                    } => {
                        subscribe_conversation_topics(
                            &mut swarm,
                            &mut subscribed_conversations,
                            &conversation_id,
                        );
                        let mut guard = store.lock();
                        match crypto::build_wire_read(
                            &identity,
                            &mut guard,
                            &sender_peer_id,
                            &conversation_id,
                            &message_id,
                        ) {
                            Ok(wire) => {
                                let topic =
                                    IdentTopic::new(format!("vibe/read/{conversation_id}"));
                                if let Err(e) =
                                    swarm.behaviour_mut().gossipsub.publish(topic, wire)
                                {
                                    eprintln!("publish read: {e}");
                                }
                            }
                            Err(e) => eprintln!("build read: {e}"),
                        }
                    }
                }
            }
            _ = announce_interval.tick(), if room_topic.is_some() => {
                if let Some(topic) = room_topic.clone() {
                    let name = display_name.read().clone();
                    let wire = build_signed_announce(&identity, &name, &listen_addrs);
                    let bytes = serde_json::to_vec(&wire).unwrap_or_default();
                    if let Err(e) = swarm.behaviour_mut().gossipsub.publish(topic, bytes) {
                        eprintln!("publish announce: {e}");
                    }
                }
            }
        }
        let _ = started;
    }

    Ok(())
}

fn build_signed_announce(
    identity: &Identity,
    display_name: &str,
    listen_addrs: &[Multiaddr],
) -> WireAnnounce {
    let expires = chrono_now_ms() + 30_000;
    let dial_addrs = announce_listen_addrs(listen_addrs);
    let payload = serde_json::json!({
        "type": "vibe/announce/2",
        "peerId": identity.peer_id_b64(),
        "displayName": display_name,
        "expiresAt": expires,
        "listenAddrs": dial_addrs,
    });
    let sig = identity.sign(payload.to_string().as_bytes());
    WireAnnounce {
        msg_type: "vibe/announce/2".into(),
        peer_id: identity.peer_id_b64(),
        display_name: display_name.to_string(),
        expires_at: expires,
        listen_addrs: dial_addrs,
        signature: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig),
    }
}

fn build_signed_room_event(
    identity: &Identity,
    display_name: &str,
    event_type: &str,
) -> WireRoomEvent {
    let at = chrono_now_ms();
    let payload = serde_json::json!({
        "type": event_type,
        "peerId": identity.peer_id_b64(),
        "displayName": display_name,
        "at": at,
    });
    let sig = identity.sign(payload.to_string().as_bytes());
    WireRoomEvent {
        msg_type: event_type.to_string(),
        peer_id: identity.peer_id_b64(),
        display_name: display_name.to_string(),
        at,
        signature: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig),
    }
}

fn publish_room_presence(
    swarm: &mut libp2p::Swarm<Behaviour>,
    identity: &Identity,
    display_name: &str,
    room_code: &str,
    event_type: &str,
) {
    let hash = room_topic_hash(room_code);
    let topic = IdentTopic::new(format!("vibe/room/{hash}/presence"));
    let wire = build_signed_room_event(identity, display_name, event_type);
    let bytes = serde_json::to_vec(&wire).unwrap_or_default();
    if let Err(e) = swarm.behaviour_mut().gossipsub.publish(topic, bytes) {
        eprintln!("publish room presence: {e}");
    }
}

fn push_room_announce_direct(
    swarm: &mut libp2p::Swarm<Behaviour>,
    identity: &Identity,
    display_name: &str,
    listen_addrs: &[Multiaddr],
    peer_id: PeerId,
) {
    let wire = build_signed_announce(identity, display_name, listen_addrs);
    swarm
        .behaviour_mut()
        .room_announce
        .send_request(&peer_id, RoomAnnounceReq(wire));
}

fn dial_addrs(swarm: &mut libp2p::Swarm<Behaviour>, addrs: Vec<Multiaddr>) {
    for addr in addrs {
        if let Err(e) = swarm.dial(addr) {
            eprintln!("dial error: {e}");
        }
    }
}

fn subscribe_conversation_topics(
    swarm: &mut libp2p::Swarm<Behaviour>,
    subscribed: &mut HashSet<String>,
    conversation_id: &str,
) {
    if !subscribed.insert(conversation_id.to_string()) {
        return;
    }
    let msg = IdentTopic::new(format!("vibe/msg/{conversation_id}"));
    let signal = IdentTopic::new(format!("vibe/signal/{conversation_id}"));
    let ack = IdentTopic::new(format!("vibe/ack/{conversation_id}"));
    let read = IdentTopic::new(format!("vibe/read/{conversation_id}"));
    if let Err(e) = swarm.behaviour_mut().gossipsub.subscribe(&msg) {
        eprintln!("subscribe msg topic: {e}");
    }
    if let Err(e) = swarm.behaviour_mut().gossipsub.subscribe(&signal) {
        eprintln!("subscribe signal topic: {e}");
    }
    if let Err(e) = swarm.behaviour_mut().gossipsub.subscribe(&ack) {
        eprintln!("subscribe ack topic: {e}");
    }
    if let Err(e) = swarm.behaviour_mut().gossipsub.subscribe(&read) {
        eprintln!("subscribe read topic: {e}");
    }
}

fn handle_behaviour_event(
    event: BehaviourEvent,
    identity: &Identity,
    store: &Arc<Mutex<EphemeralStore>>,
    app: &AppHandle,
    room_peers: &Arc<RwLock<HashMap<String, RoomPeer>>>,
    swarm: &mut libp2p::Swarm<Behaviour>,
    subscribed_conversations: &mut HashSet<String>,
) -> Option<Vec<Multiaddr>> {
    use gossipsub::Event as GossipEvent;
    use request_response::Event as RrEvent;

    match event {
        BehaviourEvent::Mdns(mdns::Event::Discovered(list)) => {
            let mut dial = Vec::new();
            for (peer_id, multiaddr) in list {
                swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                dial.push(multiaddr);
            }
            if dial.is_empty() {
                return None;
            }
            return Some(dial);
        }
        BehaviourEvent::Mdns(mdns::Event::Expired(list)) => {
            for (peer_id, _) in list {
                swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer_id);
            }
        }
        BehaviourEvent::Identify(identify::Event::Received { info, .. }) => {
            let mut dial = Vec::new();
            for addr in info.listen_addrs {
                if addr.iter().any(|p| matches!(p, Protocol::Tcp(_))) {
                    dial.push(addr);
                }
            }
            if dial.is_empty() {
                return None;
            }
            return Some(dial);
        }
        BehaviourEvent::RoomAnnounce(RrEvent::Message { message, .. }) => {
            use request_response::Message as RrMessage;
            match message {
                RrMessage::Request {
                    request, channel, ..
                } => {
                    let addrs = apply_room_announce(&request.0, identity, room_peers, app);
                    let _ = swarm.behaviour_mut().room_announce.send_response(
                        channel,
                        RoomAnnounceResp { ok: true },
                    );
                    return addrs;
                }
                RrMessage::Response { .. } => {}
            }
        }
        BehaviourEvent::Gossipsub(GossipEvent::Message { message, .. }) => {
            let topic = message.topic.as_str();

            if topic.ends_with("/presence") {
                if let Ok(event) = serde_json::from_slice::<WireRoomEvent>(&message.data) {
                    apply_room_presence(&event, identity, room_peers, app);
                }
            } else if topic.starts_with("vibe/room/") {
                if let Ok(announce) = serde_json::from_slice::<WireAnnounce>(&message.data) {
                    return apply_room_announce(&announce, identity, room_peers, app);
                }
            }

            if topic.starts_with("vibe/signal/") {
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

            if topic.starts_with("vibe/msg/") {
                let mut guard = store.lock();
                match crypto::ingest_wire_chat(identity, &mut guard, &message.data, app) {
                    Ok(Some(ingested)) => {
                        if let Ok(ack_wire) = crypto::build_wire_ack(
                            identity,
                            &mut guard,
                            &ingested.peer_id,
                            &ingested.conversation_id,
                            &ingested.id,
                        ) {
                            let conv = ingested.conversation_id.clone();
                            drop(guard);
                            subscribe_conversation_topics(
                                swarm,
                                subscribed_conversations,
                                &conv,
                            );
                            let ack_topic = IdentTopic::new(format!("vibe/ack/{conv}"));
                            if let Err(e) =
                                swarm.behaviour_mut().gossipsub.publish(ack_topic, ack_wire)
                            {
                                eprintln!("publish ack: {e}");
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(e) => eprintln!("ingest message: {e}"),
                }
            }

            if topic.starts_with("vibe/ack/") {
                let mut guard = store.lock();
                if let Err(e) =
                    crypto::ingest_wire_ack(identity, &mut guard, &message.data, app)
                {
                    eprintln!("ingest ack: {e}");
                }
            }

            if topic.starts_with("vibe/read/") {
                let mut guard = store.lock();
                if let Err(e) =
                    crypto::ingest_wire_read(identity, &mut guard, &message.data, app)
                {
                    eprintln!("ingest read: {e}");
                }
            }
        }
        _ => {}
    }

    None
}

fn apply_room_presence(
    event: &WireRoomEvent,
    identity: &Identity,
    room_peers: &Arc<RwLock<HashMap<String, RoomPeer>>>,
    app: &AppHandle,
) {
    if event.msg_type != "vibe/room/join/2" && event.msg_type != "vibe/room/leave/2" {
        return;
    }
    let payload = serde_json::json!({
        "type": event.msg_type,
        "peerId": event.peer_id,
        "displayName": event.display_name,
        "at": event.at,
    });
    let sig_bytes = match base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&event.signature)
    {
        Ok(b) => b,
        Err(_) => return,
    };
    let peer_bytes = match Identity::peer_id_from_b64(&event.peer_id) {
        Ok(b) => b,
        Err(_) => return,
    };
    if !Identity::verify(&peer_bytes, payload.to_string().as_bytes(), &sig_bytes) {
        return;
    }
    if event.peer_id == identity.peer_id_b64() {
        return;
    }

    let kind = if event.msg_type == "vibe/room/join/2" {
        "join"
    } else {
        "leave"
    };

    if kind == "join" {
        let peer = RoomPeer {
            peer_id: event.peer_id.clone(),
            display_name: event.display_name.clone(),
        };
        room_peers.write().insert(event.peer_id.clone(), peer.clone());
        let _ = app.emit("room-peer", peer);
    } else {
        room_peers.write().remove(&event.peer_id);
    }

    let _ = app.emit(
        "room-event",
        serde_json::json!({
            "kind": kind,
            "peerId": event.peer_id,
            "displayName": event.display_name,
            "at": event.at,
        }),
    );
}

fn apply_room_announce(
    announce: &WireAnnounce,
    identity: &Identity,
    room_peers: &Arc<RwLock<HashMap<String, RoomPeer>>>,
    app: &AppHandle,
) -> Option<Vec<Multiaddr>> {
    if announce.msg_type != "vibe/announce/1" && announce.msg_type != "vibe/announce/2" {
        return None;
    }
    if announce.expires_at < chrono_now_ms() {
        return None;
    }

    let payload = if announce.msg_type == "vibe/announce/2" {
        serde_json::json!({
            "type": "vibe/announce/2",
            "peerId": announce.peer_id,
            "displayName": announce.display_name,
            "expiresAt": announce.expires_at,
            "listenAddrs": announce.listen_addrs,
        })
    } else {
        serde_json::json!({
            "type": "vibe/announce/1",
            "peerId": announce.peer_id,
            "displayName": announce.display_name,
            "expiresAt": announce.expires_at,
        })
    };

    let sig_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&announce.signature)
        .ok()?;
    let peer_bytes = Identity::peer_id_from_b64(&announce.peer_id).ok()?;
    if !Identity::verify(&peer_bytes, payload.to_string().as_bytes(), &sig_bytes) {
        return None;
    }
    if announce.peer_id == identity.peer_id_b64() {
        return None;
    }

    let peer = RoomPeer {
        peer_id: announce.peer_id.clone(),
        display_name: announce.display_name.clone(),
    };
    room_peers
        .write()
        .insert(announce.peer_id.clone(), peer.clone());
    let _ = app.emit("room-peer", peer);

    let mut dial = Vec::new();
    for addr_str in &announce.listen_addrs {
        if let Ok(addr) = addr_str.parse::<Multiaddr>() {
            if should_dial_addr(&addr) {
                dial.push(addr);
            }
        }
    }
    if dial.is_empty() {
        None
    } else {
        Some(dial)
    }
}

fn announce_listen_addrs(listen_addrs: &[Multiaddr]) -> Vec<String> {
    let mut out = Vec::new();
    for addr in listen_addrs {
        if let Some(s) = publishable_multiaddr(addr) {
            if !out.contains(&s) {
                out.push(s);
            }
        }
    }

    let tcp_port = listen_addrs.iter().find_map(|a| {
        a.iter().find_map(|p| match p {
            Protocol::Tcp(port) => Some(port),
            _ => None,
        })
    });

    let Some(port) = tcp_port else {
        return out;
    };

    for ip in local_lan_ipv4_addrs() {
        if let Ok(addr) = format!("/ip4/{ip}/tcp/{port}").parse::<Multiaddr>() {
            let s = addr.to_string();
            if !out.contains(&s) {
                out.push(s);
            }
        }
    }

    // Android emulator reaches the host machine at 10.0.2.2
    if let Ok(emu_host) = format!("/ip4/10.0.2.2/tcp/{port}").parse::<Multiaddr>() {
        let s = emu_host.to_string();
        if !out.contains(&s) {
            out.push(s);
        }
    }

    out
}

fn local_lan_ipv4_addrs() -> Vec<Ipv4Addr> {
    let mut ips = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if let if_addrs::IfAddr::V4(v4) = iface.addr {
                let ip = v4.ip;
                if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() {
                    ips.push(ip);
                }
            }
        }
    }
    ips
}

/// Addresses we advertise to other peers (includes LAN + emulator host shortcut).
fn publishable_multiaddr(addr: &Multiaddr) -> Option<String> {
    if should_dial_addr(addr) {
        return Some(addr.to_string());
    }
    None
}

/// Addresses we will dial (excludes loopback except emulator host).
fn should_dial_addr(addr: &Multiaddr) -> bool {
    let mut has_tcp = false;
    let mut ip4 = None;
    for proto in addr.iter() {
        match proto {
            Protocol::Tcp(_) => has_tcp = true,
            Protocol::Ip4(ip) => ip4 = Some(ip),
            _ => {}
        }
    }
    if !has_tcp {
        return false;
    }
    match ip4 {
        Some(ip) if ip.is_loopback() => false,
        Some(ip) if ip == Ipv4Addr::new(10, 0, 2, 2) => true,
        Some(_) => true,
        None => false,
    }
}

fn emit_overlay_peer_count(app: &AppHandle, count: usize) {
    let _ = app.emit("overlay-peers-changed", count);
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
