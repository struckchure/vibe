//! Community network helpers for cross-NAT overlay (SPEC §9.5).
//! libp2p bootstrap nodes expose circuit relay + rendezvous until dedicated catalog entries ship.

/// libp2p public bootstrap nodes (connectivity to relay/rendezvous infrastructure).
pub const BOOTSTRAP_PEERS: &[&str] = &[
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQCCpWQLikRtU7N45SUCrbo3tcwgbNGM58Ec",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9BjMvrg1CCoFEPLJzfrLs",
];

/// Circuit relay v2 peers for NAT traversal (dial + reserve).
pub const RELAY_PEERS: &[&str] = BOOTSTRAP_PEERS;

/// libp2p rendezvous server multiaddrs (community-operated).
pub const RENDEZVOUS_PEERS: &[&str] = BOOTSTRAP_PEERS;
