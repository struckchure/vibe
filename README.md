# Vibe

**Vibe** is a free, open-source, fully peer-to-peer communications platform. People exchange text, voice, and video directly between devices—no Vibe-operated signaling servers, storage, or media relays. Realtime traffic uses **WebRTC**; durable artifacts users choose to keep (profiles, attachments, optional history) use **IPFS**. End-to-end encryption is mandatory for messages and signaling. The reference client is a **Tauri** app (Rust core, React UI) targeting desktop and mobile from one codebase.

The protocol and security model are defined in [SPEC.md](./SPEC.md) (draft `0.1.0`). This repository is the reference implementation.

## What works today

The first milestone (**M0**) is largely in place: encrypted 1:1 text and calls over WebRTC, with a WhatsApp-style chat UI.

| Area | Status |
|------|--------|
| Tab shell (Text / Voice / Video) | Text + in-thread voice/video calls; tabs still placeholders for call history |
| Chat UI | Resizable sidebar + thread, contacts, manual Connect (SDP exchange) |
| Identity | Ed25519 keypair; peer ID = public key; QR invite; JSON backup import/export |
| Rust core | Storage, identity, Noise XX + wire crypto, minimal libp2p gossipsub overlay |
| Messaging | WebRTC data channels (`vibe/text`) with STUN/TURN; pending queue when offline |

Incremental delivery is tracked in [plans/](./plans/). Plans [0001](./plans/0001.md) through [0004](./plans/0004.md) are **done** (text, identity, WebRTC transport, and reliable delivery across desktop ↔ mobile on the same LAN).

## Roadmap

High-level phases from [SPEC.md §16](./SPEC.md#16-phased-delivery-roadmap):

| Phase | Focus | Exit criteria (summary) |
|-------|--------|-------------------------|
| **M0** | Shell, identity, WebRTC, 1:1 encrypted text | Two clients exchange text with no central server — *mostly complete* |
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
| Rust core | Identity, encrypted storage, Noise XX + wire crypto |
| Realtime | WebRTC (STUN/TURN ICE, data channels for signaling + chat) |
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

On Linux, install packaging dependencies before bundling AppImage/deb/rpm artifacts. At minimum, `xdg-utils` provides `/usr/bin/xdg-open`, which Tauri requires at bundle time:

```bash
# Debian/Ubuntu — required for AppImage/deb/rpm bundling
sudo apt install xdg-utils
```

See [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/) for the full system-dependency list.

For iOS development with an external dev server (e.g. simulator pointing at a host machine):

```bash
bun run tauri ios dev --config '{"build":{"beforeDevCommand":""}}' --no-dev-server-wait
```

Run the Vite dev server separately (`bun run dev`) so the app loads `http://localhost:1420` per `tauri.conf.json`.

### iOS release on a physical device

`bun run tauri ios run --release` can fail with a missing `exportOptionsPlist` temp file ([tauri#14593](https://github.com/tauri-apps/tauri/issues/14593)). Use the build-and-Xcode path instead:

```bash
# Opens the Xcode project after a release build
bun run release:ios:device
```

In Xcode: select your connected iPhone/iPad as the run destination, then **Product → Run** (⌘R).

To target a specific device from the CLI (when the CLI bug is fixed):

```bash
bun run tauri ios run --release "Mohammed's iPad"
```

Unsigned IPA for CI/sideloading:

```bash
bun run release:ios
```

### Android release on a physical device (Samsung / Android 15)

Prerequisites: [Tauri Android prerequisites](https://v2.tauri.app/start/prerequisites/#android) (Android SDK, NDK, `rustup target add aarch64-linux-android`). On the phone: **Developer options → USB debugging** enabled, then connect via USB and accept the debug prompt.

Release APK for arm64 Samsung phones (output under `src-tauri/gen/android/app/build/outputs/apk/`):

```bash
bun run release:android
```

Build and install on the connected device:

```bash
bun run release:android:device
```

To install a built APK manually (release builds are signed with the Android debug keystore unless `src-tauri/gen/android/keystore.properties` is configured — see [Tauri Android signing](https://v2.tauri.app/distribute/sign/android/)):

```bash
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

If you only have an unsigned artifact from an older build, sign it once with `apksigner` and the debug keystore, then install.

### Cross-network connectivity

WebRTC uses the Metered STUN/TURN catalog in [`src/lib/ice-config.ts`](src/lib/ice-config.ts). Peers add each other via QR or `vibe://peer/…` deep links. **Primary connect:** open a mutual contact's chat — when you are **connected libp2p peers**, SDP is exchanged over gossipsub on `vibe/signal/<conversation_id>` and WebRTC connects automatically. **Fallback:** Advanced → manual `vibe://connect` link in the chat menu.

**Manual test checklist:**

| Scenario | Steps | Expected |
|----------|-------|----------|
| QR / deep link | A shows QR, B opens `vibe://peer/…` | Contact added on B |
| Overlay + auto-connect | Both devices are connected libp2p peers → open chat | Data channel opens without manual links |
| Manual connect fallback | Overlay unavailable → Advanced → connect links | Data channel opens |
| Voice call | After connected, tap call on either side | Call via `vibe/signal` DC |

**Recommended IDE:** VS Code with [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).

## Documentation

- [SPEC.md](./SPEC.md) — protocol, crypto, signaling, WebRTC framing, roadmap
- [plans/](./plans/) — what shipped in each increment and acceptance criteria
- [LICENSE](./LICENSE) — MIT

## License

MIT. See [LICENSE](./LICENSE).
