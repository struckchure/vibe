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

let signalingLocalPeerId: string | null = null;
let routes: SignalingRoutes = {};

/** One gossipsub listener per conversation — avoids handling each message twice. */
const signalingUnlistenByConversation = new Map<string, () => void>();

const SIGNAL_PUBLISH_RETRIES = 10;
const SIGNAL_PUBLISH_RETRY_MS = 350;

/** Set before publishing so gossipsub self-echo can be dropped in dispatch. */
export function setSignalingLocalPeerId(peerId: string) {
  signalingLocalPeerId = peerId;
}

export function registerSignalingRoutes(next: SignalingRoutes) {
  routes = { ...routes, ...next };
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
  if (raw.includes("InsufficientPeers")) {
    return "Could not reach your contact on the network yet — keep both devices in the same room and try again";
  }
  return raw || "Could not send call signal";
}

async function publishEncryptedSignaling(
  conversationId: string,
  encrypted: string,
  waitForDelivery: boolean
) {
  if (!waitForDelivery) {
    await api.publishSignaling(conversationId, encrypted, false);
    return;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < SIGNAL_PUBLISH_RETRIES; attempt++) {
    try {
      await api.publishSignaling(conversationId, encrypted, true);
      return;
    } catch (err) {
      lastErr = err;
      const raw = err instanceof Error ? err.message : String(err);
      if (
        !raw.includes("InsufficientPeers") ||
        attempt === SIGNAL_PUBLISH_RETRIES - 1
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, SIGNAL_PUBLISH_RETRY_MS));
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
  const encryptedPayload = unwrapSignalingWire(wirePayload);
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
