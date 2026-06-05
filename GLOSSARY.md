# Glossary

Short explanations of tools, protocols, and concepts used in **Vibe**. For normative protocol details, see [SPEC.md](./SPEC.md).

---

## Application & UI

### Bun

JavaScript runtime and package manager used for frontend dependencies and dev scripts (`bun install`, `bun run dev`).

### React

UI library for building the chat interface, call overlays, and other interactive views in `src/`.

### shadcn/ui

Copy-paste component library built on Radix UI primitives. Vibe uses it for dialogs, buttons, layout primitives, and theming (`components.json`).

### Tailwind CSS

Utility-first CSS framework (v4) used for styling across the React UI.

### TanStack Router

Type-safe file-based routing for the React app (`src/routes/`).

### Tauri

Cross-platform app framework: a **Rust** backend (`src-tauri/`) paired with a **webview** that runs the React UI. Handles native IPC, identity storage, libp2p networking, and crypto. Targets desktop (macOS, Windows, Linux) and mobile (iOS, Android) from one codebase.

### Vite

Frontend build tool and dev server. Bundles the React app and serves it during development (default port `1420`).

---

## Realtime & WebRTC

### WebRTC

Browser-native API for peer-to-peer realtime communication. Vibe uses it for 1:1 text (data channels), voice, and video. Media and data travel directly between peers once a connection is established.

### RTCPeerConnection

The WebRTC object that represents a connection to one remote peer. Vibe maintains one per contact for text and calls (`src/lib/webrtc.ts`).

### Signaling

Out-of-band exchange of connection metadata (SDP offers/answers, ICE candidates) so two peers can find a path to each other. In Vibe, signaling travels over **encrypted gossipsub** topics — not through a central server.

### SDP (Session Description Protocol)

Text format describing what media/codecs a peer wants to send and receive. Offers and answers are exchanged during WebRTC negotiation.

### ICE (Interactive Connectivity Establishment)

Process that discovers usable network paths between two peers (local LAN address, public address via STUN, or relay via TURN). ICE candidates are collected and exchanged through signaling until a working pair is found.

### STUN (Session Traversal Utilities for NAT)

Lightweight protocol that helps a peer learn its public IP and port behind a NAT. Does not relay traffic — only assists discovery. In the **Pragmatic** network profile, users may configure STUN servers; the spec prohibits hardcoded third-party STUN by default.

### TURN (Traversal Using Relays around NAT)

Relay server that forwards media when direct peer-to-peer paths fail (symmetric NAT, strict firewalls). Vibe does not operate TURN; users may optionally point at **self-hosted** TURN in the Pragmatic profile.

### SCTP / Data channel

Reliable ordered byte stream inside a WebRTC connection. Vibe labels its text channel `vibe/text` and sends encrypted chat frames over it when open.

### DTLS-SRTP

Encryption layer built into WebRTC for voice and video (RTP media). Provides confidentiality and integrity for audio/video tracks without extra application-layer crypto in v1.

### RTP (Real-time Transport Protocol)

Packet format for delivering audio and video streams over IP. WebRTC sends microphone/camera tracks as RTP inside the encrypted DTLS-SRTP tunnel.

### Mesh (full mesh)

Topology where every participant in a group call connects directly to every other participant. Vibe caps simultaneous media participants at **4** (`VIBE_GROUP_MESH_MAX`); larger groups require audio-only or async fallbacks.

### SFU / MCU

**Selective Forwarding Unit** and **Multipoint Control Unit** — server-based media topologies that mix or forward streams for large calls. Out of scope for Vibe v1; group calls use mesh instead.

### Opus / VP9 / AV1

Preferred audio (**Opus**) and video (**VP9**, **AV1** where supported) codecs negotiated in SDP during calls.

---

## P2P & Networking

### libp2p

Modular peer-to-peer networking stack (Rust) powering Vibe's overlay: discovery, pubsub signaling, optional DHT routing, and circuit relay between Vibe peers.

### Gossipsub

libp2p publish–subscribe protocol. Peers subscribe to topics (e.g. `vibe/signal/<conversation_id>`, `vibe/msg/<conversation_id>`, room topics) and relay signed messages through a mesh of subscribers — no central broker.

### mDNS

Multicast DNS for **local network discovery**. Lets Vibe clients find each other on the same LAN without internet-wide DHT lookup.

### Kademlia DHT

Distributed hash table used by libp2p for storing and looking up peer routing records across the wider network (planned/required by spec for routable peers beyond LAN).

### Circuit relay

libp2p feature that routes traffic through another Vibe peer when direct connections fail. Allowed in both **Strict** and **Pragmatic** profiles; distinct from third-party TURN.

### Rendezvous

Optional libp2p protocol for topic-based peer discovery (peers register interest in a namespace and find each other).

### Yamux

Stream multiplexer used by libp2p over TCP — multiple logical streams on one connection (e.g. Noise handshake, request/response).

### NAT

Network Address Translation — the reason many home routers hide internal IPs and why STUN/TURN/ICE are needed for cross-network WebRTC.

---

## Storage & Content Addressing

### IPFS (InterPlanetary File System)

Content-addressed distributed storage. Vibe uses IPFS (via libp2p bitswap) for durable artifacts users choose to persist: profiles, attachments, optional encrypted history — not for live chat or signaling.

### CID (Content Identifier)

Hash-based address of a blob in IPFS. Referencing content by CID verifies integrity (tampering changes the hash).

### Bitswap

IPFS block exchange protocol. Peers request and supply content blocks by CID over libp2p connections.

---

## Cryptography

### E2EE (End-to-end encryption)

Only conversation participants can read message and signaling payloads. Vibe encrypts before data leaves the device; there is no Vibe-operated decryption path.

### Ed25519

Elliptic-curve signature scheme used for **identity**: each user's **Peer ID** is their 32-byte Ed25519 public key. Also used to sign profiles, room announces, and manifests.

### X25519

Elliptic-curve Diffie-Hellman used inside the **Noise** handshake for 1:1 key agreement.

### Noise (Noise Protocol Framework)

Cryptographic handshake framework. Vibe v1 uses the **Noise XX** pattern over libp2p (`/vibe/noise/1`) to establish session keys before trusting WebRTC signaling.

### XChaCha20-Poly1305

Authenticated encryption for message bodies and signaling ciphertext (`WireChat` envelopes). Provides confidentiality and tamper detection.

### Sender Keys

Per-sender symmetric key chains for **group** encryption (planned M2). Each member encrypts with their own chain; keys are distributed when someone joins.

### Double Ratchet

Forward-secrecy protocol for async 1:1 messaging (planned M3). Allows decrypting messages sent while a peer was offline after keys rotate.

### MLS (Messaging Layer Security)

IETF standard for group E2EE ([RFC 9420](https://www.rfc-editor.org/rfc/rfc9420)). Documented as a future target; v1 uses Sender Keys instead.

---

## Vibe protocol concepts

### Peer ID

Canonical user identifier: the raw 32-byte Ed25519 public key (displayed as base64url). Used in contacts, conversation IDs, and invite URIs (`vibe://peer/<publicKey>`).

### Conversation ID

Stable hash identifying a chat: for 1:1, `SHA-256` of the sorted pair of peer IDs; for groups, `SHA-256` of the group manifest CID.

### WireChat

JSON wire format for encrypted chat payloads on gossipsub and the WebRTC data channel. Contains ciphertext produced with the session key established via Noise.

### Room code

Shared secret (6–8 characters) for scoped LAN discovery. Joining a room publishes signed **announce** messages on a derived gossipsub topic; messaging still requires adding the peer as a contact.

### Strict / Pragmatic profiles

Network policy presets. **Strict** avoids public STUN, HTTP IPFS gateways, and third-party pinners — NAT traversal relies on host candidates, hole punching, and libp2p relay. **Pragmatic** allows user-configured STUN, gateways, and pinners (all off by default).

### Direct vs Network (transport badge)

UI labels in the chat thread: **Direct** when the WebRTC data channel is open; **Network** when messages fall back to gossipsub relay.

---

## Data formats

### CBOR (Concise Binary Object Representation)

Compact binary serialization. The spec recommends CBOR for canonical on-wire hashing; the reference client currently uses JSON for `WireChat` and signaling with CBOR as a follow-up.

### JSON

Human-readable serialization used today for identity backup, room announces, and chat wire format in the reference implementation.

---

## See also

- [SPEC.md](./SPEC.md) — full protocol, security model, and roadmap
- [README.md](./README.md) — what works today and dev setup
- [plans/](./plans/) — incremental delivery notes
