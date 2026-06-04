# Vibe: Decentralized Communications Protocol

| Field            | Value                    |
| ---------------- | ------------------------ |
| **Spec version** | `0.1.0-draft`            |
| **Status**       | Draft                    |
| **License**      | MIT ([LICENSE](LICENSE)) |

## 1. Summary

**Vibe** is a free, open-source, fully peer-to-peer communications platform. Users exchange text, voice, and video directly between devices using **WebRTC** for realtime transport and **IPFS** ([content-addressed storage](https://ipfs.tech/)) for durable artifacts they choose to persist. There is no Vibe-operated signaling, storage, or relay infrastructure. End-to-end encryption is mandatory for message and signaling payloads. Clients are built with **Tauri** (Rust core, webview UI) targeting desktop and mobile from a single codebase.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 2. Goals and Non-Goals

### 2.1 Goals

| Area            | Requirement                                                                                |
| --------------- | ------------------------------------------------------------------------------------------ |
| **Realtime**    | 1:1 and group text; voice; video over WebRTC                                               |
| **Persistence** | User-selected artifacts on IPFS: profiles, attachments, optional encrypted message history |
| **Topology**    | Fully P2P: no Vibe-hosted servers for signaling, storage, or media relay                   |
| **Trust**       | E2EE by default; integrity of published blobs via IPFS CIDs                                |
| **FOSS**        | Reproducible builds; open protocol and schema documentation                                |

### 2.2 Non-Goals (v1)

- Federated or centralized chat servers, SMS bridges, or paid SaaS backends
- Server-based SFU/MCU for large group video (mesh limits are documented instead)
- Blockchain identity, tokens, or on-chain registries
- Platform-wide content moderation or global username reservation
- Push notification infrastructure operated by the Vibe project (see §12.4)

---

## 3. Design Principles

1. **Content addressing** — Immutable public artifacts (profiles, attachments) are referenced by [IPFS CID](https://ipfs.tech/); verification uses the hash of content, not URLs or hostnames.

2. **Location independence** — Peers are identified by cryptographic keys. Network location (IP, NAT type) is ephemeral and MUST NOT be treated as identity.

3. **Fail-open UX, fail-closed security** — Degraded connectivity MAY disable features with clear user feedback. Cryptographic verification failures MUST abort the affected operation; clients MUST NOT fall back to plaintext for user content.

4. **User-controlled network posture** — **Strict** and **Pragmatic** profiles (§11) let users choose how much optional third-party assistance to allow. Neither profile introduces Vibe-operated infrastructure.

5. **Minimal metadata** — Designs SHOULD minimize metadata exposed on the overlay network; known limits are documented honestly (§13).

---

## 4. High-Level Architecture

### 4.1 Component Diagram

```mermaid
flowchart TB
  subgraph clients [TauriClients]
    UI[WebViewUI]
    Core[RustCore]
    UI --> Core
  end

  subgraph realtime [WebRTCLayer]
    DC[DataChannels_Text]
    AV[MediaTracks_VoiceVideo]
  end

  subgraph network [P2PNetwork]
    Libp2p[libp2p_Transport]
    IPFS[IPFS_ContentStore]
    DHT[DHT_Discovery]
    PubSub[PubSub_Signaling]
  end

  Core --> Libp2p
  Core --> IPFS
  Core --> realtime
  Libp2p --> DHT
  Libp2p --> PubSub
  PubSub -->|session_descriptions_ICE| realtime
  IPFS -->|CIDs_profiles_history| clients
```

### 4.2 Layer Responsibilities

| Layer               | Responsibility                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| **WebView UI**      | Presentation, local UX state. MUST NOT hold long-lived secrets; MUST NOT perform protocol cryptography.         |
| **Tauri Rust core** | libp2p/IPFS node, identity, session state, envelope encode/decode, WebRTC peer connection lifecycle, IPC to UI. |
| **WebRTC**          | Ephemeral realtime: SCTP data channels (text), RTP media (voice/video). DTLS-SRTP provided by WebRTC stack.     |
| **libp2p**          | Peer routing, DHT, pubsub signaling, optional circuit relay between Vibe peers.                                 |
| **IPFS**            | Content-addressed store for signed profiles, attachments, optional encrypted history segments.                  |

### 4.3 Data Planes

- **Realtime plane** — WebRTC peer connections between conversation members. Active only while peers are online and connected.
- **Overlay plane** — libp2p (DHT, pubsub, relay). Used for discovery, signaling, presence gossip, membership events.
- **Persistence plane** — IPFS blocks/DAGs pinned locally; optional remote pinners in Pragmatic profile (§11).

---

## 5. Identity and Addressing

### 5.1 Peer Identity

- Each human operator has a **root identity**: an Ed25519 keypair generated on-device.
- **Peer ID** — The canonical identifier is the 32-byte Ed25519 public key, encoded for display as base64url (no padding) or multibase per implementation preference. Implementations MUST use the raw public key bytes for protocol logic.
- Private keys MUST remain in the Rust core (OS secure storage where available). They MUST NOT be exported to the webview or IPFS.

### 5.2 Profile Document

- An optional **Profile** (schema `vibe/profile/1`, §A.2) contains display name, avatar CID, bio, and capability flags.
- The Profile MUST be signed by the peer's root key. Clients verify signature before display.
- The latest profile is referenced by CID; older profile CIDs remain valid but SHOULD be ignored after update.

### 5.3 Contacts and Verification

- There is no global username registry. Adding a contact requires knowing their Peer ID (QR code, link, manual entry).
- Clients MUST display a **safety number** (fingerprint of Peer ID) and support out-of-band verification.
- Until verified, clients SHOULD show an unverified state and MAY restrict calling.

### 5.4 Multi-Device (v1 Scope)

- v1 treats one device as **primary** per root identity on a given installation.
- **Multi-device** (device sub-keys signed by root, cross-device history sync) is specified in Appendix A.4 as a future capability; v1 implementations MUST NOT claim cross-device E2EE sync.

---

## 6. Cryptography

### 6.1 Algorithms

| Purpose                      | Algorithm                            |
| ---------------------------- | ------------------------------------ |
| Identity signing             | Ed25519                              |
| Key agreement (1:1)          | X25519 via Noise                     |
| Symmetric encryption         | XChaCha20-Poly1305                   |
| Hashing / conversation IDs   | SHA-256                              |
| Attachment/content integrity | Multihash per IPFS (SHA-256 default) |

### 6.2 Direct (1:1) Sessions

- v1 **MUST** establish 1:1 messaging keys using **Noise XX** pattern over an authenticated libp2p stream or initial WebRTC data channel bootstrap as defined in §9.3.
- Session state MUST be persisted locally encrypted at rest.
- **Double Ratchet** for offline/async message gaps is a **Phase M3** enhancement (§16); until then, peers that were offline during send rely on optional IPFS history backup (§7) or message loss with user-visible notice.

### 6.3 Group Messaging (v1)

- Groups **MUST** use **Sender Keys** (chain per sender, distributed on member join).
- Maximum group size for Sender Key distribution: **50** members.
- **MLS** ([RFC 9420](https://www.rfc-editor.org/rfc/rfc9420)) is the documented target for a future spec revision; v1 implementations MUST NOT mix MLS and Sender Keys on the same conversation.

### 6.4 WebRTC Media

- Voice and video **MUST** use DTLS-SRTP as implemented by the WebRTC stack.
- Additional E2EE (insertable streams) is out of scope for v1.

### 6.5 IPFS Published Content

- All user content uploaded to IPFS **MUST** be **encrypt-then-publish** with keys available only to intended recipients.
- CIDs in the clear MAY appear in manifests; plaintext of message bodies or attachments MUST NOT be pinned.

### 6.6 Signing

- Profile updates, `GroupManifest` revisions, and membership events **MUST** be signed by the acting peer's root key (or delegated device key when Appendix A.4 is implemented).

---

## 7. IPFS Usage

### 7.1 Persisted vs Ephemeral

| Data                      | IPFS?    | Notes                             |
| ------------------------- | -------- | --------------------------------- |
| Signed profile            | Yes      | Immutable; new version = new CID  |
| Public key bundle         | Yes      | May be embedded in profile        |
| Attachments / large media | Yes      | Chunked; encrypted                |
| Message history backup    | Optional | User opt-in; encrypted CAR or DAG |
| ICE candidates / SDP      | No       | Ephemeral pubsub only             |
| Typing / presence         | No       | Ephemeral pubsub only             |
| Active call state         | No       | WebRTC session only               |

### 7.2 Pinning Model

- Each client **MUST** pin content it publishes locally.
- Recipients **SHOULD** pin attachments they wish to retain.
- Availability is best-effort: no guarantee without sufficient replicas. Pragmatic profile MAY use user-configured remote pinners (§11).

### 7.3 Content Types

| Schema ID               | Description                           |
| ----------------------- | ------------------------------------- |
| `vibe/profile/1`        | Signed user profile                   |
| `vibe/attachment/1`     | Encrypted blob metadata + chunk CIDs  |
| `vibe/history/1`        | Encrypted message log segment (M3)    |
| `vibe/group-manifest/1` | Signed group metadata and member list |

Encoding **SHOULD** be CBOR for canonical hashing; JSON MAY be accepted for debugging if CBOR is normative on wire.

### 7.4 Retrieval

- Peers **MUST** fetch via libp2p/IPFS bitswap from connected peers.
- Pragmatic profile MAY allow read-only HTTP gateway URLs for fetch-only (§11); Strict profile MUST NOT.

---

## 8. WebRTC Realtime Plane

### 8.1 Peer Connections

- One `RTCPeerConnection` (or equivalent) per remote peer in a conversation for v1.
- Group calls use **full mesh**: each pair negotiates media as needed.

### 8.2 Text (Data Channels)

- **MUST** use an ordered, reliable SCTP data channel per 1:1 peer connection (labeled `vibe/text`).
- Application frames **MUST** be length-prefixed CBOR envelopes (§15.2) containing `protocol_version`, `conversation_id`, `seq`, and ciphertext produced by the session keys (§6).

### 8.3 Voice and Video

| Mode       | Topology                                                                |
| ---------- | ----------------------------------------------------------------------- |
| 1:1 call   | Single peer connection with audio + optional video tracks               |
| Group call | Mesh; max **4** simultaneous media participants (`VIBE_GROUP_MESH_MAX`) |

- Beyond `VIBE_GROUP_MESH_MAX`, clients **MUST** warn the user and **SHOULD** offer audio-only or async IPFS attachment fallback. SFU/TURN operated by Vibe is prohibited.

### 8.4 Codecs (Informative)

- Audio: Opus preferred.
- Video: VP9 or AV1 where hardware permits; negotiate via SDP.

### 8.5 Connection Lifecycle

- Clients **MUST** renegotiate ICE on network change.
- Hang up **MUST** close peer connections and stop media tracks.

---

## 9. Signaling and Discovery

### 9.1 Discovery

- Peers **MUST** participate in libp2p **Kademlia DHT** for routable peer records.
- **Bootstrap peers**: a signed, community-maintained list MAY ship with the app; it MUST NOT be exclusive Vibe infrastructure. Users MAY override or disable bootstrap list entries.
- **Rendezvous** (libp2p rendezvous protocol) **MAY** be used for topic-based discovery.

### 9.2 Signaling Transport

```mermaid
sequenceDiagram
  participant A as PeerA
  participant PS as Libp2pPubSub
  participant B as PeerB

  A->>PS: encrypted_signal_offer
  PS->>B: forward
  B->>PS: encrypted_signal_answer
  PS->>A: forward
  A->>B: WebRTC_DTLS_media
```

- Signaling messages **MUST** be published on gossipsub topic `vibe/signal/<conversation_id>` where `conversation_id` is defined in §10.1.
- Payloads **MUST** be encrypted to all current conversation members (1:1 or group envelope).
- SDP offers/answers and ICE candidates **MUST** travel only inside these encrypted envelopes.

### 9.3 Initial Key Bootstrap

- If no Noise session exists, peers **MUST** complete Noise XX over a libp2p protocol stream `/vibe/noise/1` before trusting signaling payloads.
- WebRTC signaling **MUST NOT** proceed until the Noise handshake completes successfully.

### 9.4 ICE and NAT

| Profile       | ICE behavior                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| **Strict**    | Host + srflx via peer reflexive; relay **only** via libp2p circuit relay to other Vibe peers          |
| **Pragmatic** | Above plus optional user-configured STUN servers; optional **self-hosted** TURN (disabled by default) |

- Public STUN in Pragmatic profile **MUST** be user-enabled (non-empty list). Default install **MUST NOT** hardcode third-party STUN URLs.

---

## 10. Conversation Models

### 10.1 Conversation ID

- **Direct**: `conversation_id = SHA-256(sort(peer_id_a, peer_id_b))` where sort is lexicographic on raw 32-byte keys.
- **Group**: `conversation_id = SHA-256(group_manifest_cid_bytes)` after first manifest publish.

### 10.2 Direct Conversations

- Exactly two members. Either peer MAY initiate text or call.
- Block list is local: blocked Peer IDs MUST NOT receive decrypted processing; signaling MAY be dropped silently.

### 10.3 Group Conversations

- Creator publishes `vibe/group-manifest/1` to IPFS and distributes CID via pubsub `vibe/group/announce`.
- Membership changes (add/remove) **MUST** be signed events; manifest CID updates chain via `prev_manifest_cid`.
- New members **MUST** receive Sender Keys from all current senders before decrypting group traffic.

### 10.4 Presence

- Heartbeats **MAY** be sent on `vibe/presence/<conversation_id>` at most once per 60 seconds per peer.
- Presence is ephemeral; not stored on IPFS unless history backup includes system events (opt-in).

### 10.5 Typing and Read Receipts

- **MAY** use ephemeral pubsub on `vibe/ephemeral/<conversation_id>`.
- **MUST NOT** persist to IPFS unless user enables history backup including metadata events.

---

## 11. Network Profiles

Vibe defines two network profiles. The active profile **MUST** be visible in settings. Switching profiles **MUST** take effect on the next connection attempt.

### 11.1 Comparison

| Capability                                | Strict             | Pragmatic                             |
| ----------------------------------------- | ------------------ | ------------------------------------- |
| Public STUN servers                       | **MUST NOT** use   | **MAY** use user-configured list      |
| Third-party IPFS HTTP gateway (read-only) | **MUST NOT** use   | **MAY** use user-configured URLs      |
| Remote IPFS pinners                       | **MUST NOT** use   | **MAY** use user-configured endpoints |
| libp2p circuit relay via other Vibe peers | Allowed            | Allowed                               |
| Vibe-operated servers                     | **MUST NOT** exist | **MUST NOT** exist                    |

### 11.2 Default Behavior

- Factory default profile: **Pragmatic** with empty STUN, gateway, and pinner lists (behaves similarly to Strict until the user adds helpers).
- Implementations **MUST** log (locally, not transmit) when Pragmatic helpers are used for a given operation.

### 11.3 Strict Profile Requirements

- All IPFS retrieval **MUST** occur over libp2p/bitswap from peers.
- NAT traversal **MUST** rely on host candidates, UDP hole punching, and libp2p relay only.
- Clients **SHOULD** surface connectivity guidance when Strict mode fails behind symmetric NAT.

### 11.4 Pragmatic Profile Requirements

- User-configured STUN **MUST** be editable and clearable.
- TURN, if used, **MUST** be URL and credentials supplied by the user (self-hosted). Default TURN **MUST NOT** ship with the app.
- Remote pinners **MUST NOT** receive decryption keys; they store ciphertext only.

---

## 12. Tauri Implementation Notes

_This section is informative for implementers; it does not mandate specific crate versions._

### 12.1 Process Model

- **Rust core** owns: libp2p swarm, IPFS blockstore, Noise sessions, WebRTC `PeerConnection` factory, SQLite or sled for local encrypted state.
- **Webview** communicates via Tauri commands/events; IPC payloads **MUST NOT** contain private keys or plaintext message bodies except for display of already-decrypted content in RAM.

### 12.2 Indicative Rust Ecosystem

| Concern       | Indicative crates / APIs                                            |
| ------------- | ------------------------------------------------------------------- |
| P2P transport | `libp2p`                                                            |
| IPFS          | `ipfs-embed`, `rust-ipfs`, or controlled `kubo` sidecar (see §B.3)  |
| WebRTC        | `webrtc` (pure Rust) or platform WebRTC via Tauri mobile plugins    |
| Crypto        | `ed25519-dalek`, `x25519-dalek`, `chacha20poly1305`, `snow` (Noise) |

### 12.3 Platform Notes

- **Desktop**: full background connectivity; IPFS node **SHOULD** run while app is open.
- **Mobile**: OS may suspend background tasks; incoming calls while suspended are best-effort without push (§12.4).
- **Permissions**: camera, microphone, notifications (local only), filesystem access scoped per OS guidelines.

### 12.4 Background and Incoming Sessions

- Pure P2P v1 has **no** Vibe push gateway. Peers discover each other when both are online on the overlay.
- Implementations **SHOULD** document platform limitations (iOS/Android background execution) honestly in user-facing help.

---

## 13. Security and Threat Model

### 13.1 Assets

- Message plaintext, media streams, private keys, contact list, local session state.

### 13.2 Threats and Mitigations

| Threat                    | Mitigation                                                                       |
| ------------------------- | -------------------------------------------------------------------------------- |
| MITM on signaling         | Noise handshake before signaling; encrypted SDP/ICE inside group/direct envelope |
| Impersonation             | Safety numbers; signed profiles and manifests                                    |
| Tampering with IPFS blobs | CID verification; signatures on manifests; decrypt-then-authenticate             |
| Replay (pubsub)           | Seq numbers in envelopes; session nonces in Noise                                |
| Malicious peer flood      | Rate limits; block list; gossipsub mesh limits                                   |

### 13.3 Known Limitations

- **Metadata**: Pubsub topics and timing leak conversation activity; padding and sealed sender are future work (v2).
- **Availability**: IPFS content may be unreachable if no peer pins it.
- **Group video scale**: Mesh is O(n²); capped at `VIBE_GROUP_MESH_MAX`.
- **Offline 1:1**: Without M3 ratchet/history, messages sent while recipient is offline may be lost unless history backup is enabled.

### 13.4 Responsible Disclosure

Security issues **SHOULD** be reported via the repository's `SECURITY.md` when published. Embargo and credit practices follow maintainer policy.

---

## 14. Privacy, Legal, and Abuse

- **Moderation**: There is no global moderation layer. Users control block lists locally.
- **Export / delete**: Clients **MUST** offer export of local data and deletion of local state; IPFS unpublish is best-effort (stop pinning; cannot erase all remote copies).
- **Compliance**: Age gating and regional telecom rules are the responsibility of distributors, not this spec.
- **Illegal content**: Implementers **SHOULD** document that users are responsible for content they publish to the public IPFS network.

---

## 15. Protocol Versioning and Interoperability

### 15.1 Spec and Protocol Version

- This document uses semver for spec releases.
- Every wire envelope **MUST** include `protocol_version` (string, e.g. `"1"`).

### 15.2 Envelope Format (normative sketch)

```cbor
{
  "protocol_version": "1",
  "type": "text" | "signal" | "membership" | ...,
  "conversation_id": <32 bytes>,
  "seq": <uint64>,
  "sender_peer_id": <32 bytes>,
  "ciphertext": <bytes>,
  "timestamp": <uint64 unix ms>
}
```

- `ciphertext` **MUST** cover the inner payload for the given `type`.
- Unknown `protocol_version` **MUST** reject with user-visible error.

### 15.3 Capability Negotiation

- During Noise handshake, peers **MUST** exchange `Capabilities` struct: supported profiles, max mesh size, history backup, codec preferences.
- Intersection of capabilities **MUST** be used for the session.

### 15.4 Independent Implementations

Any client implementing `vibe/*` schemas, §6 crypto, §9 signaling, and §8 WebRTC framing **SHOULD** interoperate with Vibe reference clients of the same `protocol_version`.

---

## 16. Phased Delivery Roadmap

| Phase  | Deliverables                                                                                   | Exit criteria                                                            |
| ------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **M0** | Tauri shell; root identity; libp2p connect; Noise handshake; 1:1 text over WebRTC data channel | Two clients exchange encrypted text with no central server               |
| **M1** | 1:1 voice/video; `vibe/profile/1` on IPFS; `vibe/attachment/1`                                 | Verified profile CID; completed voice call; file round-trip via CID      |
| **M2** | Groups (text); Sender Keys; Strict/Pragmatic settings UI; group manifest                       | 5-member group text; profile toggle affects STUN behavior                |
| **M3** | Optional `vibe/history/1` on IPFS; Double Ratchet for async 1:1; multi-device (Appendix A.4)   | Offline message delivery after reconnect; second device receives history |

Dependencies: M1 depends on M0; M2 depends on M0; M3 depends on M1 and M2.

---

## 17. Appendices

The following appendices provide schemas, glossary, references, and open implementation questions.

### Appendix A: Schemas and Examples

### A.1 Glossary

| Term            | Definition                                                   |
| --------------- | ------------------------------------------------------------ |
| **CID**         | Content Identifier — hash-based address for IPFS data        |
| **DHT**         | Distributed hash table for peer routing (libp2p Kademlia)    |
| **DTLS-SRTP**   | WebRTC media encryption                                      |
| **E2EE**        | End-to-end encryption                                        |
| **ICE**         | Interactive Connectivity Establishment for NAT traversal     |
| **MLS**         | Messaging Layer Security (group E2EE standard, future)       |
| **Noise**       | Framework for mutual key exchange (XX pattern in v1)         |
| **Peer ID**     | 32-byte Ed25519 public key identifying a user                |
| **Pubsub**      | Gossipsub topic-based broadcast on libp2p                    |
| **SDP**         | Session Description Protocol for WebRTC negotiation          |
| **Sender Keys** | Per-sender symmetric chain for group encryption (v1)         |
| **STUN/TURN**   | NAT discovery / relay protocols (Pragmatic, user-controlled) |

### A.2 Example Profile (`vibe/profile/1`)

```json
{
  "schema": "vibe/profile/1",
  "peer_id": "<32-byte-ed25519-pubkey-base64url>",
  "display_name": "Ada",
  "avatar_cid": "bafy...",
  "bio": "Building peer-to-peer tools.",
  "capabilities": {
    "protocol_version": "1",
    "history_backup": false,
    "group_mesh_max": 4
  },
  "issued_at": 1717536000000,
  "signature": "<ed25519-signature-bytes-base64url>"
}
```

On wire, implementations **SHOULD** use canonical CBOR; JSON above is illustrative.

### A.3 Example Attachment Metadata (`vibe/attachment/1`)

```json
{
  "schema": "vibe/attachment/1",
  "conversation_id": "<32-byte-hex>",
  "filename": "diagram.png",
  "mime_type": "image/png",
  "size": 1048576,
  "chunk_cids": ["bafy...", "bafy..."],
  "encryption": {
    "algorithm": "XChaCha20-Poly1305",
    "nonce": "<bytes>"
  },
  "signature": "<ed25519-signature>"
}
```

### A.4 Multi-Device (Future)

- Root key signs **device keys** (separate Ed25519 per device).
- `vibe/device/1` document lists device public keys and expiration.
- IPFS history segments encrypted to a group key rotated on membership change.
- Not required for M0–M2 compliance.

---

### Appendix B: References and Open Questions

### B.1 Normative and Informative References

- [IPFS — content addressing and distributed storage](https://ipfs.tech/)
- [libp2p specification](https://github.com/libp2p/specs)
- [WebRTC 1.0](https://www.w3.org/TR/webrtc/)
- [RFC 2119 — requirement keywords](https://www.rfc-editor.org/rfc/rfc2119)
- [RFC 9420 — MLS](https://www.rfc-editor.org/rfc/rfc9420) (future group crypto)
- [Noise Protocol Framework](https://noiseprotocol.org/)
- [Tauri](https://tauri.app/) — cross-platform client shell

### B.2 Constants

| Constant                        | Value                              |
| ------------------------------- | ---------------------------------- |
| `VIBE_GROUP_MESH_MAX`           | 4                                  |
| `VIBE_GROUP_SENDER_KEYS_MAX`    | 50                                 |
| `VIBE_PRESENCE_INTERVAL_SEC`    | 60                                 |
| Noise protocol name             | `Noise_XX_25519_ChaChaPoly_SHA256` |
| libp2p noise stream protocol ID | `/vibe/noise/1`                    |

### B.3 Open Questions (Implementation Time)

1. **IPFS embedding** — `rust-ipfs` / `ipfs-embed` vs bundled `kubo` sidecar: tradeoffs for mobile binary size and battery.
2. **WebRTC on mobile Tauri** — pure Rust `webrtc` crate vs platform WebRTC bindings for hardware codecs.
3. **Topic privacy** — whether v2 should use encrypted topic names derived from `conversation_id`.
4. **Sealed sender** — whether pubsub envelopes should hide `sender_peer_id` from non-members on encrypted topics.
5. **Bootstrap list governance** — community signing keys and update cadence for default bootstrap peers.

---

## Document History

| Version       | Date       | Changes       |
| ------------- | ---------- | ------------- |
| `0.1.0-draft` | 2026-06-04 | Initial draft |

---
