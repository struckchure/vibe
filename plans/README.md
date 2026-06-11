# Vibe implementation plans

Numbered phases (`NNNN.md`) track incremental delivery. Each plan links to [SPEC.md](../SPEC.md) milestones where relevant.

| Plan | Status | Scope |
|------|--------|--------|
| [0001.md](./0001.md) | done | Text + discovery: WhatsApp UI, room codes, libp2p, encrypted gossipsub |
| [0002.md](./0002.md) | done | Identity: Ed25519 keypair, peer ID = public key, QR invite, JSON backup import/export, regenerate |
| [0003.md](./0003.md) | done | WebRTC text: `vibe/text` data channel, encrypted signaling, gossipsub fallback |
| [0004.md](./0004.md) | done | Chat delivery: mDNS, announce v2 dial, topic subscribe, STUN, overlay UX |
| [0005.md](./0005.md) | done | Voice/video 1:1 calls from chat thread header |
| [0006.md](./0006.md) | in_progress | SPEC-aligned realtime: catalog ICE, single PC, Noise XX |
| [0007.md](./0007.md) | done | Auto-connect on chat open via gossipsub (connected libp2p peers only) |

**Status values:** `planned` | `in_progress` | `done`
