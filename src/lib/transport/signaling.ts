import * as api from "@/lib/tauri";

import type {
  CallSignalingMessage,
  SignalingEnvelope,
  SignalingMessage,
  TextSignalingMessage,
} from "./types";
import { isCallSignal } from "./types";

/** Outer gossip envelope (Rust SignalWire); legacy payloads pass through as ciphertext. */
type SignalWireOuter = {
  senderPeerId?: string;
  payload?: string;
};

export type SignalingRoutes = {
  onCall?: (
    remotePeerId: string,
    conversationId: string,
    msg: CallSignalingMessage
  ) => void | Promise<void>;
  onText?: (
    remotePeerId: string,
    conversationId: string,
    msg: TextSignalingMessage
  ) => void | Promise<void>;
  onIce?: (
    remotePeerId: string,
    conversationId: string,
    candidate: RTCIceCandidateInit
  ) => void | Promise<void>;
};

type SignalChannelEntry = {
  remotePeerId: string;
  conversationId: string;
  channel: RTCDataChannel;
};

let signalingLocalPeerId: string | null = null;
let routes: SignalingRoutes = {};
const signalChannels = new Map<string, SignalChannelEntry>();

/** One gossipsub listener per conversation — avoids handling each message twice. */
const signalingUnlistenByConversation = new Map<string, () => void>();

const SIGNAL_DELIVERY_RETRIES = 10;
const SIGNAL_DELIVERY_RETRY_MS = 350;
const SIGNAL_DC_RETRIES = 15;
const SIGNAL_DC_RETRY_MS = 200;

export function setSignalingLocalPeerId(peerId: string) {
  signalingLocalPeerId = peerId;
}

export function registerSignalingRoutes(next: SignalingRoutes) {
  routes = { ...routes, ...next };
}

export function attachSignalingChannel(
  remotePeerId: string,
  conversationId: string,
  channel: RTCDataChannel
) {
  const existing = signalChannels.get(remotePeerId);
  if (existing?.channel === channel) {
    return;
  }
  channel.onmessage = (ev) => {
    const payload =
      typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
    void dispatchSignaling(remotePeerId, conversationId, payload);
  };
  signalChannels.set(remotePeerId, { remotePeerId, conversationId, channel });
}

export function detachSignalingChannel(remotePeerId: string) {
  signalChannels.delete(remotePeerId);
}

export function isSignalingChannelOpen(peerId: string): boolean {
  return signalChannels.get(peerId)?.channel.readyState === "open";
}

function getSignalChannel(peerId: string): RTCDataChannel | undefined {
  const entry = signalChannels.get(peerId);
  if (entry?.channel.readyState === "open") {
    return entry.channel;
  }
  return undefined;
}

function unwrapSignalingWire(raw: string): string | null {
  try {
    const outer = JSON.parse(raw) as SignalWireOuter;
    if (
      typeof outer.senderPeerId === "string" &&
      typeof outer.payload === "string"
    ) {
      if (
        signalingLocalPeerId &&
        outer.senderPeerId === signalingLocalPeerId
      ) {
        return null;
      }
      return outer.payload;
    }
  } catch {
    /* legacy: raw encrypted blob */
  }
  return raw;
}

function formatPublishError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes("InsufficientPeers") || raw.includes("no connected libp2p")) {
    return "Your contact is not connected on the libp2p overlay yet";
  }
  return raw || "Could not send signaling";
}

async function sendOnSignalChannel(
  remotePeerId: string,
  encrypted: string,
  waitForDelivery: boolean
) {
  const send = () => {
    const channel = getSignalChannel(remotePeerId);
    if (!channel) {
      throw new Error("signaling channel not open");
    }
    channel.send(JSON.stringify({ payload: encrypted }));
  };

  if (!waitForDelivery) {
    send();
    return;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < SIGNAL_DC_RETRIES; attempt++) {
    try {
      send();
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === SIGNAL_DC_RETRIES - 1) {
        break;
      }
      await new Promise((r) => setTimeout(r, SIGNAL_DC_RETRY_MS));
    }
  }
  throw new Error(formatPublishError(lastErr));
}

async function publishEncryptedSignaling(
  conversationId: string,
  remotePeerId: string,
  encrypted: string,
  waitForDelivery: boolean
) {
  if (isSignalingChannelOpen(remotePeerId)) {
    await sendOnSignalChannel(remotePeerId, encrypted, waitForDelivery);
    return;
  }

  const connected = await api.isOverlayPeerConnected(remotePeerId);
  if (!connected) {
    throw new Error("contact is not a connected libp2p peer");
  }

  if (!waitForDelivery) {
    await api.publishSignaling(conversationId, encrypted, false);
    return;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < SIGNAL_DELIVERY_RETRIES; attempt++) {
    try {
      await api.publishSignaling(conversationId, encrypted, true);
      return;
    } catch (err) {
      lastErr = err;
      const raw = err instanceof Error ? err.message : String(err);
      if (
        !raw.includes("InsufficientPeers") &&
        !raw.includes("no connected libp2p")
      ) {
        break;
      }
      if (attempt === SIGNAL_DELIVERY_RETRIES - 1) {
        break;
      }
      await new Promise((r) => setTimeout(r, SIGNAL_DELIVERY_RETRY_MS));
    }
  }
  throw new Error(formatPublishError(lastErr));
}

export async function publishSignalingMessage(
  conversationId: string,
  remotePeerId: string,
  msg: SignalingMessage,
  options?: { waitForDelivery?: boolean }
) {
  const body: SignalingEnvelope = signalingLocalPeerId
    ? { ...msg, from: signalingLocalPeerId }
    : msg;
  const encrypted = await api.encryptSignaling(
    remotePeerId,
    JSON.stringify(body)
  );
  await publishEncryptedSignaling(
    conversationId,
    remotePeerId,
    encrypted,
    options?.waitForDelivery ?? true
  );
}

export function publishSignalingBestEffort(
  conversationId: string,
  remotePeerId: string,
  msg: SignalingMessage
) {
  void publishSignalingMessage(conversationId, remotePeerId, msg, {
    waitForDelivery: false,
  });
}

export async function ensureConversationSignaling(
  conversationId: string,
  remotePeerId: string
) {
  if (signalingUnlistenByConversation.has(conversationId)) {
    return;
  }
  const unlisten = await api.onSignaling(conversationId, (payload) => {
    void dispatchSignaling(remotePeerId, conversationId, payload);
  });
  signalingUnlistenByConversation.set(conversationId, unlisten);
}

export function teardownConversationSignaling(conversationId: string) {
  const unlisten = signalingUnlistenByConversation.get(conversationId);
  if (unlisten) {
    unlisten();
    signalingUnlistenByConversation.delete(conversationId);
  }
}

async function dispatchSignaling(
  remotePeerId: string,
  conversationId: string,
  wirePayload: string
) {
  let encryptedPayload: string | null = null;
  try {
    const outer = JSON.parse(wirePayload) as { payload?: string };
    if (typeof outer.payload === "string") {
      encryptedPayload = outer.payload;
    }
  } catch {
    /* not JSON — gossipsub inner ciphertext */
  }
  if (!encryptedPayload) {
    encryptedPayload = unwrapSignalingWire(wirePayload);
  }
  if (!encryptedPayload) {
    return;
  }

  let plaintext: string;
  try {
    plaintext = await api.decryptSignaling(remotePeerId, encryptedPayload);
  } catch {
    return;
  }

  let envelope: SignalingEnvelope;
  try {
    envelope = JSON.parse(plaintext) as SignalingEnvelope;
  } catch {
    return;
  }

  if (
    envelope.from &&
    signalingLocalPeerId &&
    envelope.from === signalingLocalPeerId
  ) {
    return;
  }

  const { from: _from, ...msg } = envelope;

  if (isCallSignal(msg)) {
    await routes.onCall?.(remotePeerId, conversationId, msg);
    return;
  }

  if (msg.type === "ice" && msg.candidate) {
    await routes.onIce?.(remotePeerId, conversationId, msg.candidate);
    return;
  }

  if (msg.type === "offer" || msg.type === "answer") {
    await routes.onText?.(remotePeerId, conversationId, msg);
  }
}
