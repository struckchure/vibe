//! libp2p overlay: gossipsub signaling + circuit relay + rendezvous discovery.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use futures::StreamExt;
use libp2p::gossipsub::{self, IdentTopic, MessageAuthenticity, ValidationMode};
use libp2p::identify;
use libp2p::multiaddr::Protocol;
use libp2p::relay;
use libp2p::rendezvous;
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
    rendezvous: rendezvous::client::Behaviour,
    relay: relay::client::Behaviour,
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
    listen_addrs: Arc<RwLock<Vec<String>>>,
    app: AppHandle,
    store: Arc<Mutex<EphemeralStore>>,
}

impl NetworkHandle {
    pub fn new(identity: Arc<Identity>, store: Arc<Mutex<EphemeralStore>>, app: AppHandle) -> Self {
        let started = Arc::new(RwLock::new(false));
        let connected_libp2p_peers = Arc::new(RwLock::new(HashSet::new()));
        let listen_addrs = Arc::new(RwLock::new(Vec::new()));
        let cmd_tx = Mutex::new(None);

        let handle = Self {
            cmd_tx,
            started: started.clone(),
            connected_libp2p_peers: connected_libp2p_peers.clone(),
            listen_addrs: listen_addrs.clone(),
            app: app.clone(),
            store: store.clone(),
        };
        handle.spawn_swarm(
            identity,
            store,
            app,
            started,
            connected_libp2p_peers,
            listen_addrs,
        );
        handle
    }

    fn spawn_swarm(
        &self,
        identity: Arc<Identity>,
        store: Arc<Mutex<EphemeralStore>>,
        app: AppHandle,
        started: Arc<RwLock<bool>>,
        connected_libp2p_peers: Arc<RwLock<HashSet<PeerId>>>,
        listen_addrs: Arc<RwLock<Vec<String>>>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        *self.cmd_tx.lock() = Some(tx);

        tauri::async_runtime::spawn(async move {
            if let Err(e) = run_swarm(
                identity,
                store,
                app,
                rx,
                started,
                connected_libp2p_peers,
                listen_addrs,
            )
            .await
            {
                eprintln!("swarm error: {e}");
            }
        });
    }

    pub fn restart(&self, identity: Arc<Identity>) {
        *self.cmd_tx.lock() = None;
        *self.started.write() = false;
        self.connected_libp2p_peers.write().clear();
        self.listen_addrs.write().clear();
        self.spawn_swarm(
            identity,
            self.store.clone(),
            self.app.clone(),
            self.started.clone(),
            self.connected_libp2p_peers.clone(),
            self.listen_addrs.clone(),
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

    pub fn get_listen_addrs(&self) -> Vec<String> {
        self.listen_addrs.read().clone()
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

fn contact_peer_id_for_libp2p(store: &EphemeralStore, pid: PeerId) -> Option<String> {
    for contact in store.list_contacts() {
        if libp2p_peer_id_from_contact(&contact.peer_id).ok() == Some(pid) {
            return Some(contact.peer_id);
        }
    }
    None
}

fn contact_libp2p_for_conversation(
    store: &EphemeralStore,
    conversation_id: &str,
) -> Option<PeerId> {
    for contact in store.list_contacts() {
        if contact.conversation_id == conversation_id {
            return libp2p_peer_id_from_contact(&contact.peer_id).ok();
        }
    }
    None
}

fn peer_id_from_multiaddr(addr: &Multiaddr) -> Option<PeerId> {
    addr.iter().find_map(|p| {
        if let Protocol::P2p(id) = p {
            Some(id)
        } else {
            None
        }
    })
}

fn relay_peer_ids_from_config() -> HashSet<PeerId> {
    let mut ids = HashSet::new();
    for addr_str in crate::bootstrap::RELAY_PEERS {
        if let Ok(addr) = addr_str.parse::<Multiaddr>() {
            if let Some(id) = peer_id_from_multiaddr(&addr) {
                ids.insert(id);
            }
        }
    }
    ids
}

fn relay_transport_addr(addr: &Multiaddr) -> Multiaddr {
    let mut out = Multiaddr::empty();
    for proto in addr.iter() {
        if matches!(proto, Protocol::P2p(_)) {
            break;
        }
        out = out.with(proto);
    }
    out
}

fn try_relay_listen(
    swarm: &mut libp2p::Swarm<Behaviour>,
    relay_peer_id: PeerId,
    connected_addr: &Multiaddr,
) {
    let base = relay_transport_addr(connected_addr);
    if base.is_empty() {
        return;
    }
    let circuit = base
        .with(Protocol::P2p(relay_peer_id))
        .with(Protocol::P2pCircuit);
    if let Err(e) = swarm.listen_on(circuit) {
        eprintln!("relay listen_on: {e}");
    }
}

fn conversation_rendezvous_namespace(conversation_id: &str) -> Option<rendezvous::Namespace> {
    rendezvous::Namespace::new(format!("vibe/conv/{conversation_id}")).ok()
}

fn bootstrap_overlay(swarm: &mut libp2p::Swarm<Behaviour>) {
    let mut dialed = HashSet::new();
    for list in [
        crate::bootstrap::BOOTSTRAP_PEERS,
        crate::bootstrap::RELAY_PEERS,
        crate::bootstrap::RENDEZVOUS_PEERS,
    ] {
        for addr_str in list {
            if !dialed.insert(*addr_str) {
                continue;
            }
            if let Ok(addr) = addr_str.parse::<Multiaddr>() {
                if let Err(e) = swarm.dial(addr) {
                    eprintln!("bootstrap dial {addr_str}: {e}");
                }
            }
        }
    }
}

fn rendezvous_register_conv(swarm: &mut libp2p::Swarm<Behaviour>, conversation_id: &str) {
    if crate::bootstrap::RENDEZVOUS_PEERS.is_empty() {
        return;
    }
    let Some(namespace) = conversation_rendezvous_namespace(conversation_id) else {
        return;
    };
    for addr_str in crate::bootstrap::RENDEZVOUS_PEERS {
        let Ok(addr) = addr_str.parse::<Multiaddr>() else {
            continue;
        };
        let Some(rz_peer) = peer_id_from_multiaddr(&addr) else {
            continue;
        };
        if let Err(e) = swarm.behaviour_mut().rendezvous.register(
            namespace.clone(),
            rz_peer,
            Some(600),
        ) {
            eprintln!("rendezvous register: {e}");
        }
    }
}

fn rendezvous_discover_conv(swarm: &mut libp2p::Swarm<Behaviour>, conversation_id: &str) {
    if crate::bootstrap::RENDEZVOUS_PEERS.is_empty() {
        return;
    }
    let namespace = conversation_rendezvous_namespace(conversation_id);
    for addr_str in crate::bootstrap::RENDEZVOUS_PEERS {
        let Ok(addr) = addr_str.parse::<Multiaddr>() else {
            continue;
        };
        let Some(rz_peer) = peer_id_from_multiaddr(&addr) else {
            continue;
        };
        swarm
            .behaviour_mut()
            .rendezvous
            .discover(namespace.clone(), None, Some(25), rz_peer);
    }
}

fn dial_addrs(swarm: &mut libp2p::Swarm<Behaviour>, addrs: &[Multiaddr]) {
    for addr in addrs {
        if let Err(e) = swarm.dial(addr.clone()) {
            eprintln!("dial {addr}: {e}");
        }
    }
}

fn dial_contact_addrs(store: &EphemeralStore, conversation_id: &str, swarm: &mut libp2p::Swarm<Behaviour>) {
    let contacts: Vec<_> = store
        .list_contacts()
        .into_iter()
        .filter(|c| c.conversation_id == conversation_id)
        .collect();
    for contact in contacts {
        for addr_str in &contact.dial_addrs {
            if let Ok(addr) = addr_str.parse::<Multiaddr>() {
                if let Err(e) = swarm.dial(addr) {
                    eprintln!("dial contact addr: {e}");
                }
            }
        }
    }
}

fn dial_rendezvous_registrations(
    swarm: &mut libp2p::Swarm<Behaviour>,
    registrations: &[rendezvous::Registration],
    expected_peers: &HashSet<PeerId>,
) {
    let local = *swarm.local_peer_id();
    for reg in registrations {
        let peer = reg.record.peer_id();
        if peer == local || !expected_peers.contains(&peer) {
            continue;
        }
        let addrs: Vec<_> = reg.record.addresses().to_vec();
        dial_addrs(swarm, &addrs);
    }
}

fn dialable_multiaddr(mut addr: Multiaddr, local_peer_id: PeerId) -> Option<String> {
    if !addr.iter().any(|p| matches!(p, Protocol::P2p(_))) {
        addr.push(Protocol::P2p(local_peer_id));
    }
    Some(addr.to_string())
}

fn record_listen_addr(
    listen_addrs: &Arc<RwLock<Vec<String>>>,
    addr: Multiaddr,
    local_peer_id: PeerId,
) {
    let Some(dialable) = dialable_multiaddr(addr, local_peer_id) else {
        return;
    };
    let mut addrs = listen_addrs.write();
    if !addrs.contains(&dialable) {
        addrs.push(dialable);
    }
}

fn emit_overlay_peer_count(app: &AppHandle, count: usize) {
    let _ = app.emit("overlay-peers-changed", count);
}

fn emit_overlay_peer_connected(app: &AppHandle, peer_id: &str) {
    let _ = app.emit(
        "overlay-peer-connected",
        serde_json::json!({ "peerId": peer_id }),
    );
}

async fn run_swarm(
    identity: Arc<Identity>,
    store: Arc<Mutex<EphemeralStore>>,
    app: AppHandle,
    mut rx: mpsc::UnboundedReceiver<NetworkCommand>,
    _started: Arc<RwLock<bool>>,
    connected_libp2p_peers: Arc<RwLock<HashSet<PeerId>>>,
    listen_addrs: Arc<RwLock<Vec<String>>>,
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

    let rendezvous_client = rendezvous::client::Behaviour::new(local_key.clone());

    let mut swarm = SwarmBuilder::with_existing_identity(local_key)
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_relay_client(noise::Config::new, yamux::Config::default)?
        .with_behaviour(|_, relay| Behaviour {
            gossipsub,
            identify,
            rendezvous: rendezvous_client,
            relay,
        })?
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
        .build();

    swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse()?)?;
    bootstrap_overlay(&mut swarm);

    let relay_peer_ids = relay_peer_ids_from_config();
    let mut relay_listen_attempted: HashSet<PeerId> = HashSet::new();
    let mut subscribed_conversations: HashSet<String> = HashSet::new();
    let mut active_conversations: HashMap<String, PeerId> = HashMap::new();
    let mut rendezvous_interval =
        tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(2), Duration::from_secs(5));

    loop {
        tokio::select! {
            event = swarm.select_next_some() => {
                match event {
                    SwarmEvent::NewListenAddr { address, .. } => {
                        if address.iter().any(|p| matches!(p, Protocol::P2pCircuit)) {
                            swarm.add_external_address(address.clone());
                        }
                        record_listen_addr(&listen_addrs, address, local_peer_id);
                    }
                    SwarmEvent::ExternalAddrConfirmed { address } => {
                        swarm.add_external_address(address);
                    }
                    SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
                        if relay_peer_ids.contains(&peer_id)
                            && relay_listen_attempted.insert(peer_id)
                        {
                            try_relay_listen(&mut swarm, peer_id, endpoint.get_remote_address());
                        }
                        if peer_id != local_peer_id {
                            swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                            let mut peers = connected_libp2p_peers.write();
                            if peers.insert(peer_id) {
                                emit_overlay_peer_count(&app, peers.len());
                                drop(peers);
                                let guard = store.lock();
                                if let Some(contact_peer_id) =
                                    contact_peer_id_for_libp2p(&guard, peer_id)
                                {
                                    emit_overlay_peer_connected(&app, &contact_peer_id);
                                }
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
                            &active_conversations,
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
                        let guard = store.lock();
                        if let Some(contact_pid) = contact_libp2p_for_conversation(&guard, &conversation_id) {
                            active_conversations.insert(conversation_id.clone(), contact_pid);
                            rendezvous_register_conv(&mut swarm, &conversation_id);
                            rendezvous_discover_conv(&mut swarm, &conversation_id);
                            dial_contact_addrs(&guard, &conversation_id, &mut swarm);
                        }
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
                        dial_addrs(&mut swarm, &addrs);
                    }
                }
            }
            _ = rendezvous_interval.tick() => {
                let conv_ids: Vec<String> = active_conversations.keys().cloned().collect();
                for conversation_id in conv_ids {
                    rendezvous_register_conv(&mut swarm, &conversation_id);
                    rendezvous_discover_conv(&mut swarm, &conversation_id);
                    let guard = store.lock();
                    dial_contact_addrs(&guard, &conversation_id, &mut swarm);
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
    swarm: &mut libp2p::Swarm<Behaviour>,
    _subscribed: &mut HashSet<String>,
    active_conversations: &HashMap<String, PeerId>,
) {
    use gossipsub::Event as GossipEvent;

    match event {
        BehaviourEvent::Gossipsub(GossipEvent::Message { message, .. }) => {
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
        BehaviourEvent::Relay(relay::client::Event::ReservationReqAccepted {
            relay_peer_id,
            ..
        }) => {
            eprintln!("relay reservation accepted from {relay_peer_id}");
        }
        BehaviourEvent::Rendezvous(rendezvous::client::Event::Discovered { registrations, .. }) => {
            let expected: HashSet<PeerId> = active_conversations.values().copied().collect();
            dial_rendezvous_registrations(swarm, &registrations, &expected);
        }
        BehaviourEvent::Identify(identify::Event::Received { info, peer_id, .. }) => {
            if active_conversations.values().any(|p| *p == peer_id) {
                let addrs: Vec<_> = info
                    .listen_addrs
                    .into_iter()
                    .filter(|a| a.iter().any(|p| matches!(p, Protocol::Tcp(_))))
                    .collect();
                dial_addrs(swarm, &addrs);
            }
        }
        _ => {}
    }
}
