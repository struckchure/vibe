# Vibe

**Vibe** is a free, open-source, fully peer-to-peer communications platform. People exchange text, voice, and video directly between devices—no Vibe-operated signaling servers, storage, or media relays. Realtime traffic uses **WebRTC**; durable artifacts users choose to keep (profiles, attachments, optional history) use **IPFS**. End-to-end encryption is mandatory for messages and signaling. The reference client is a **Tauri** app (Rust core, React UI) targeting desktop and mobile from one codebase.

The protocol and security model are defined in [SPEC.md](./SPEC.md) (draft `0.1.0`). This repository is the reference implementation.

## What works today

The first milestone (**M0**) is largely in place: encrypted 1:1 text between peers on a local overlay, with a WhatsApp-style chat UI.

| Area | Status |
|------|--------|
| Tab shell (Text / Voice / Video) | Text + in-thread voice/video calls; tabs still placeholders for call history |
| Chat UI | Resizable sidebar + thread, contacts, room discovery |
| Identity | Ed25519 keypair; peer ID = public key; QR invite; JSON backup import/export |
| Overlay | libp2p gossipsub, mDNS LAN discovery, room codes, Noise session keys |
| Messaging | Encrypted gossipsub + WebRTC `vibe/text` data channel with fallback |

Incremental delivery is tracked in [plans/](./plans/). Plans [0001](./plans/0001.md) through [0004](./plans/0004.md) are **done** (text, identity, WebRTC transport, and reliable delivery across desktop ↔ mobile on the same LAN).

## Roadmap

High-level phases from [SPEC.md §16](./SPEC.md#16-phased-delivery-roadmap):

| Phase | Focus | Exit criteria (summary) |
|-------|--------|-------------------------|
| **M0** | Shell, identity, libp2p, 1:1 encrypted text | Two clients exchange text with no central server — *mostly complete* |
| **M1** | 1:1 voice/video; IPFS profiles and attachments | Voice call; profile and file round-trip via CID |
| **M2** | Group text; Sender Keys; Strict/Pragmatic network settings | 5-member group chat; settings affect STUN behavior |
| **M3** | Optional encrypted history on IPFS; Double Ratchet; multi-device | Offline delivery after reconnect; second device sync |

New implementation slices will be added as numbered plans under [plans/](./plans/) (see [plans/README.md](./plans/README.md)).

### Out of scope for v1

- Centralized or federated chat servers
- Server-based SFU/MCU for large group video
- Blockchain identity or on-chain registries
- Vibe-operated push notification infrastructure

Details and rationale are in [SPEC.md §2](./SPEC.md#2-goals-and-non-goals).

## Tech stack

| Layer | Choices |
|-------|---------|
| Shell | [Tauri v2](https://v2.tauri.app/) (Rust) |
| UI | React 19, [TanStack Router](https://tanstack.com/router), [shadcn/ui](https://ui.shadcn.com/), Tailwind CSS 4 |
| P2P | libp2p (gossipsub, Noise, mDNS) |
| Realtime | WebRTC data channels (+ STUN for NAT) |
| Persistence (planned) | IPFS content-addressed blobs |

## Project layout

```
vibe/
├── src/              # React UI and routes
├── src-tauri/        # Rust: identity, crypto, network, WebRTC, Tauri commands
├── plans/            # Numbered implementation plans (0001, 0002, …)
├── SPEC.md           # Protocol and architecture spec
└── README.md
```

## Development

**Prerequisites:** [Rust](https://rustup.rs/), [Bun](https://bun.sh/), and platform tooling for [Tauri](https://v2.tauri.app/start/prerequisites/) (Xcode for iOS, Android SDK for Android, etc.).

```bash
# Install frontend dependencies
bun install

# Desktop dev (starts Vite + Tauri)
bun run tauri dev

# Frontend only (no native IPC; UI-only work)
bun run dev

# Production build
bun run tauri build
```

For iOS development with an external dev server (e.g. simulator pointing at a host machine):

```bash
bun run tauri ios dev --config '{"build":{"beforeDevCommand":""}}' --no-dev-server-wait
```

Run the Vite dev server separately (`bun run dev`) so the app loads `http://localhost:1420` per `tauri.conf.json`.

**Recommended IDE:** VS Code with [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).

## Documentation

- [SPEC.md](./SPEC.md) — protocol, crypto, signaling, WebRTC framing, roadmap
- [plans/](./plans/) — what shipped in each increment and acceptance criteria
- [LICENSE](./LICENSE) — MIT

## License

MIT. See [LICENSE](./LICENSE).
