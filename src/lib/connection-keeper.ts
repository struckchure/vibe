import type { Contact } from "@/lib/tauri";
import * as api from "@/lib/tauri";
import {
  closePeerConnection,
  ensureTextTransport,
  isTransportReady,
  setSignalingLocalPeerId,
  subscribeTransportState,
} from "@/lib/webrtc";
import { ensureConversationSignaling } from "@/lib/transport/signaling";
import {
  ensureTrackerSignaling,
  isTrackerSignalingReady,
  subscribeTrackerSignalingState,
  teardownTrackerSignaling,
} from "@/lib/transport/tracker-signaling";

/** Interval between WebRTC transport setup attempts while signaling is ready. */
const TRANSPORT_POLL_MS = 3_000;
/** Re-announce on tracker/overlay while waiting for a peer. */
export const SIGNALING_REANNOUNCE_MS = 45_000;
/** Max time in "connecting" before cycling retry. */
const CONNECTING_TIMEOUT_MS = 30_000;
/** Full restart cycles when both peers are online but WebRTC setup stalls. */
export const MAX_CONNECTING_RETRIES = 5;

export type KeeperPhase =
  | "connected"
  | "connecting"
  | "waiting_signaling"
  | "unreachable"
  | "idle";

export type KeeperContactState = {
  phase: KeeperPhase;
  retryAttempt: number;
  maxRetries: number;
};

type ContactRuntime = {
  contact: Contact;
  retryAttempt: number;
  gaveUp: boolean;
  connectingTimer: ReturnType<typeof setTimeout> | null;
  reannounceTimer: ReturnType<typeof setTimeout> | null;
  transportTimer: ReturnType<typeof setInterval> | null;
};

const listeners = new Set<() => void>();
const overlayConnectedPeers = new Set<string>();
let localPeerId: string | undefined;
let runtimes = new Map<string, ContactRuntime>();
let started = false;

function contactKey(contact: Contact): string {
  return contact.conversationId;
}

function notify() {
  for (const fn of listeners) {
    fn();
  }
}

function isSignalingReady(contact: Contact): boolean {
  return (
    isTrackerSignalingReady(contact.conversationId) ||
    overlayConnectedPeers.has(contact.peerId)
  );
}

function computePhase(runtime: ContactRuntime): KeeperPhase {
  const { contact, gaveUp } = runtime;
  if (!localPeerId) {
    return "idle";
  }
  if (isTransportReady(contact.peerId)) {
    return "connected";
  }
  if (gaveUp) {
    return "unreachable";
  }
  if (isSignalingReady(contact)) {
    return "connecting";
  }
  return "waiting_signaling";
}

function getSnapshot(): Map<string, KeeperContactState> {
  const snapshot = new Map<string, KeeperContactState>();
  for (const [key, runtime] of runtimes) {
    snapshot.set(key, {
      phase: computePhase(runtime),
      retryAttempt: runtime.retryAttempt,
      maxRetries: MAX_CONNECTING_RETRIES,
    });
  }
  return snapshot;
}

let cachedSnapshot = new Map<string, KeeperContactState>();

function refreshSnapshot() {
  const next = getSnapshot();
  let changed = next.size !== cachedSnapshot.size;
  if (!changed) {
    for (const [key, value] of next) {
      const prev = cachedSnapshot.get(key);
      if (
        !prev ||
        prev.phase !== value.phase ||
        prev.retryAttempt !== value.retryAttempt
      ) {
        changed = true;
        break;
      }
    }
  }
  if (changed) {
    cachedSnapshot = next;
    notify();
  }
}

function restartSignalingStack(contact: Contact): void {
  if (!localPeerId) {
    return;
  }
  teardownTrackerSignaling(contact.conversationId);
  closePeerConnection(contact.peerId);
  void api.startNetwork();
  void api.subscribeConversation(contact.conversationId);
  void ensureTrackerSignaling(
    contact.conversationId,
    localPeerId,
    contact.peerId,
  );
  void ensureConversationSignaling(contact.conversationId, contact.peerId);
}

function clearContactTimers(runtime: ContactRuntime) {
  if (runtime.connectingTimer) {
    clearTimeout(runtime.connectingTimer);
    runtime.connectingTimer = null;
  }
  if (runtime.reannounceTimer) {
    clearTimeout(runtime.reannounceTimer);
    runtime.reannounceTimer = null;
  }
  if (runtime.transportTimer) {
    clearInterval(runtime.transportTimer);
    runtime.transportTimer = null;
  }
}

function attemptTransport(contact: Contact) {
  if (!localPeerId || !isSignalingReady(contact)) {
    return;
  }
  if (isTransportReady(contact.peerId)) {
    refreshSnapshot();
    return;
  }
  void ensureTextTransport(
    localPeerId,
    contact.peerId,
    contact.conversationId,
  );
}

function scheduleConnectingRetry(runtime: ContactRuntime) {
  if (runtime.connectingTimer) {
    clearTimeout(runtime.connectingTimer);
  }
  runtime.connectingTimer = setTimeout(() => {
    runtime.connectingTimer = null;
    if (isTransportReady(runtime.contact.peerId) || runtime.gaveUp) {
      return;
    }
    if (!isSignalingReady(runtime.contact)) {
      return;
    }
    if (runtime.retryAttempt >= MAX_CONNECTING_RETRIES) {
      runtime.gaveUp = true;
      refreshSnapshot();
      return;
    }
    runtime.retryAttempt += 1;
    if (isSignalingReady(runtime.contact)) {
      // The signaling tunnel is healthy — recycle only the WebRTC session so
      // a fresh offer goes out over the existing tunnel. Tearing the tracker
      // session down too forces a full re-announce on both sides, which
      // rarely converges across NATs.
      closePeerConnection(runtime.contact.peerId);
    } else {
      restartSignalingStack(runtime.contact);
    }
    refreshSnapshot();
    armContactLoops(runtime);
  }, CONNECTING_TIMEOUT_MS);
}

function scheduleReannounce(runtime: ContactRuntime) {
  if (runtime.reannounceTimer) {
    clearTimeout(runtime.reannounceTimer);
  }
  runtime.reannounceTimer = setTimeout(() => {
    runtime.reannounceTimer = null;
    if (isTransportReady(runtime.contact.peerId) || runtime.gaveUp) {
      return;
    }
    if (isSignalingReady(runtime.contact)) {
      return;
    }
    restartSignalingStack(runtime.contact);
    scheduleReannounce(runtime);
  }, SIGNALING_REANNOUNCE_MS);
}

function armContactLoops(runtime: ContactRuntime) {
  clearContactTimers(runtime);

  const { contact } = runtime;
  if (isTransportReady(contact.peerId)) {
    refreshSnapshot();
    return;
  }

  if (isSignalingReady(contact)) {
    if (runtime.retryAttempt === 1 || runtime.gaveUp === false) {
      runtime.retryAttempt = Math.max(1, runtime.retryAttempt);
    }
    attemptTransport(contact);
    runtime.transportTimer = setInterval(
      () => attemptTransport(contact),
      TRANSPORT_POLL_MS,
    );
    scheduleConnectingRetry(runtime);
  } else {
    void ensureTrackerSignaling(
      contact.conversationId,
      localPeerId!,
      contact.peerId,
    );
    void api.subscribeConversation(contact.conversationId);
    void ensureConversationSignaling(contact.conversationId, contact.peerId);
    scheduleReannounce(runtime);
  }

  refreshSnapshot();
}

function stopContactRuntime(runtime: ContactRuntime) {
  clearContactTimers(runtime);
  teardownTrackerSignaling(runtime.contact.conversationId);
}

function ensureOverlayWatchers() {
  if (started) {
    return;
  }
  started = true;

  void api.startNetwork();
  void api.onOverlayPeerConnected((peerId) => {
    overlayConnectedPeers.add(peerId);
    for (const runtime of runtimes.values()) {
      if (runtime.contact.peerId === peerId) {
        runtime.retryAttempt = 1;
        runtime.gaveUp = false;
        armContactLoops(runtime);
      }
    }
    refreshSnapshot();
  });

  subscribeTrackerSignalingState(() => {
    for (const runtime of runtimes.values()) {
      if (isSignalingReady(runtime.contact)) {
        runtime.retryAttempt = 1;
        runtime.gaveUp = false;
        armContactLoops(runtime);
      }
    }
    refreshSnapshot();
  });

  subscribeTransportState(() => {
    refreshSnapshot();
  });
}

function syncOverlayPeers(contacts: Contact[]) {
  for (const contact of contacts) {
    void api.isOverlayPeerConnected(contact.peerId).then((connected) => {
      if (connected) {
        overlayConnectedPeers.add(contact.peerId);
      } else {
        overlayConnectedPeers.delete(contact.peerId);
      }
      const runtime = runtimes.get(contactKey(contact));
      if (runtime && connected) {
        runtime.retryAttempt = 1;
        runtime.gaveUp = false;
        armContactLoops(runtime);
      }
      refreshSnapshot();
    });
  }
}

export function syncConnectionKeeper(
  peerId: string | undefined,
  contacts: Contact[] | undefined,
): void {
  if (!peerId) {
    shutdownConnectionKeeper();
    return;
  }

  ensureOverlayWatchers();
  localPeerId = peerId;
  setSignalingLocalPeerId(peerId);

  const nextKeys = new Set<string>();
  for (const contact of contacts ?? []) {
    const key = contactKey(contact);
    nextKeys.add(key);
    let runtime = runtimes.get(key);
    if (!runtime) {
      runtime = {
        contact,
        retryAttempt: 1,
        gaveUp: false,
        connectingTimer: null,
        reannounceTimer: null,
        transportTimer: null,
      };
      runtimes.set(key, runtime);
      armContactLoops(runtime);
    } else {
      runtime.contact = contact;
      if (
        !runtime.transportTimer &&
        !runtime.reannounceTimer &&
        !runtime.connectingTimer
      ) {
        armContactLoops(runtime);
      }
    }
  }

  for (const [key, runtime] of runtimes) {
    if (!nextKeys.has(key)) {
      stopContactRuntime(runtime);
      runtimes.delete(key);
    }
  }

  syncOverlayPeers(contacts ?? []);
  refreshSnapshot();
}

/** Focus/visibility events fire in bursts; a refresh mid-handshake is destructive. */
const REFRESH_DEBOUNCE_MS = 5_000;
let lastRefreshAt = 0;

export function refreshAllConnections(): void {
  if (!localPeerId) {
    return;
  }
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_DEBOUNCE_MS) {
    return;
  }
  lastRefreshAt = now;
  for (const runtime of runtimes.values()) {
    if (isTransportReady(runtime.contact.peerId)) {
      continue;
    }
    runtime.retryAttempt = 1;
    runtime.gaveUp = false;
    if (!isSignalingReady(runtime.contact)) {
      restartSignalingStack(runtime.contact);
    }
    armContactLoops(runtime);
  }
  refreshSnapshot();
}

export function shutdownConnectionKeeper(): void {
  for (const runtime of runtimes.values()) {
    stopContactRuntime(runtime);
  }
  runtimes = new Map();
  localPeerId = undefined;
  cachedSnapshot = new Map();
  notify();
}

export function getKeeperContactState(
  conversationId: string | undefined,
): KeeperContactState {
  if (!conversationId) {
    return { phase: "idle", retryAttempt: 1, maxRetries: MAX_CONNECTING_RETRIES };
  }
  return (
    cachedSnapshot.get(conversationId) ?? {
      phase: "idle",
      retryAttempt: 1,
      maxRetries: MAX_CONNECTING_RETRIES,
    }
  );
}

export function subscribeConnectionKeeper(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getKeeperSnapshot(): Map<string, KeeperContactState> {
  return cachedSnapshot;
}
