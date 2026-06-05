//! Community bootstrap and rendezvous endpoints for cross-network overlay discovery.
//! SPEC §9.1 — not Vibe-exclusive; replace or extend for production deployments.

/// libp2p public bootstrap nodes (DHT connectivity).
pub const BOOTSTRAP_PEERS: &[&str] = &[
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQCCpWQLikRtU7N45SUCrbo3tcwgbNGM58Ec",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9BjMvrg1CCoFEPLJzfrLs",
];

/// Optional libp2p rendezvous server multiaddrs (community-operated).
/// Empty by default — DHT room records still work via BOOTSTRAP_PEERS.
pub const RENDEZVOUS_PEERS: &[&str] = &[];
