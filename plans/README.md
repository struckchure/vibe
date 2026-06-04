# Vibe implementation plans

Numbered phases (`NNNN.md`) track incremental delivery. Each plan links to [SPEC.md](../SPEC.md) milestones where relevant.

| Plan | Status | Scope |
|------|--------|--------|
| [0001.md](./0001.md) | done | Text + discovery: WhatsApp UI, room codes, libp2p, encrypted gossipsub |
| [0002.md](./0002.md) | done | Identity: Ed25519 keypair, peer ID = public key, QR invite, JSON backup import/export, regenerate |
| [0003.md](./0003.md) | done | WebRTC text: `vibe/text` data channel, encrypted signaling, gossipsub fallback |
| [0004.md](./0004.md) | done | Chat delivery: mDNS, announce v2 dial, topic subscribe, STUN, overlay UX |

**Status values:** `planned` | `in_progress` | `done`
