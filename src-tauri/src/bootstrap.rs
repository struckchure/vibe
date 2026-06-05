//! Community bootstrap, relay, and rendezvous endpoints for cross-network overlay discovery.
//! SPEC §9.1 — not Vibe-exclusive; replace or extend for production deployments.

/// libp2p public bootstrap nodes (DHT connectivity).
pub const BOOTSTRAP_PEERS: &[&str] = &[
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQCCpWQLikRtU7N45SUCrbo3tcwgbNGM58Ec",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9BjMvrg1CCoFEPLJzfrLs",
];

/// Circuit relay v2 peers for NAT traversal (dial + reserve).
/// Uses public libp2p bootstrap nodes; replace with a dedicated community relay for production.
pub const RELAY_PEERS: &[&str] = BOOTSTRAP_PEERS;

/// libp2p rendezvous server multiaddrs (community-operated).
/// Uses public bootstrap nodes that may expose rendezvous; override with a dedicated server.
pub const RENDEZVOUS_PEERS: &[&str] = BOOTSTRAP_PEERS;
