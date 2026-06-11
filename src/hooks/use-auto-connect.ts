import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { Contact } from "@/lib/tauri";
import * as api from "@/lib/tauri";
import {
  closePeerConnection,
  ensureTextTransport,
  isTransportReady,
  setSignalingLocalPeerId,
} from "@/lib/webrtc";
import { ensureConversationSignaling } from "@/lib/transport/signaling";
import {
  ensureTrackerSignaling,
  isTrackerSignalingReady,
  subscribeTrackerSignalingState,
  teardownTrackerSignaling,
} from "@/lib/transport/tracker-signaling";
import { useContactOverlayConnected } from "@/hooks/use-overlay-peers";

/** Interval between WebRTC transport setup attempts while signaling is ready. */
const RETRY_MS = 3_000;
/** How long to wait for an offline peer to come online before giving up. */
export const OFFLINE_WAIT_MS = 5 * 60_000;
/** Re-announce on tracker/overlay while waiting for an offline peer. */
const SIGNALING_REANNOUNCE_MS = 45_000;
/** Max time in "connecting" (signaling ready, transport not) before cycling retry. */
const CONNECTING_TIMEOUT_MS = 30_000;
/** Full restart cycles when both peers are online but WebRTC setup stalls. */
export const MAX_CONNECTING_RETRIES = 5;

export type AutoConnectPhase =
  | "connected"
  | "connecting"
  | "waiting_signaling"
  | "unreachable"
  | "idle";

export type AutoConnectState = {
  phase: AutoConnectPhase;
  retryAttempt: number;
  maxRetries: number;
};

function useTrackerReady(conversationId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeTrackerSignalingState,
    () => (conversationId ? isTrackerSignalingReady(conversationId) : false),
    () => false,
  );
}

function restartSignalingStack(contact: Contact, localPeerId: string): void {
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

export function useAutoConnect(
  contact: Contact | undefined,
  localPeerId: string | undefined,
): AutoConnectState {
  const overlayConnected = useContactOverlayConnected(contact?.peerId);
  const trackerReady = useTrackerReady(contact?.conversationId);
  const signalingReady = trackerReady || overlayConnected;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(1);
  const [gaveUp, setGaveUp] = useState(false);
  const contactRef = useRef(contact);
  const localPeerIdRef = useRef(localPeerId);
  contactRef.current = contact;
  localPeerIdRef.current = localPeerId;

  useEffect(() => {
    setRetryAttempt(1);
    setGaveUp(false);
  }, [contact?.conversationId]);

  useEffect(() => {
    if (signalingReady) {
      setRetryAttempt(1);
    }
  }, [signalingReady, contact?.conversationId]);

  const cycleConnectingRetryRef = useRef(() => {});
  cycleConnectingRetryRef.current = () => {
    const c = contactRef.current;
    const lid = localPeerIdRef.current;
    if (!c || !lid) {
      return;
    }
    setRetryAttempt((attempt) => {
      if (attempt >= MAX_CONNECTING_RETRIES) {
        setGaveUp(true);
        return attempt;
      }
      restartSignalingStack(c, lid);
      return attempt + 1;
    });
  };

  // Peer offline: keep announcing until they come online or OFFLINE_WAIT_MS elapses.
  useEffect(() => {
    if (!contact || !localPeerId || gaveUp) {
      return;
    }
    if (signalingReady || isTransportReady(contact.peerId)) {
      return;
    }

    const deadline = Date.now() + OFFLINE_WAIT_MS;
    let timer: ReturnType<typeof setTimeout>;

    const scheduleReannounce = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setGaveUp(true);
        return;
      }
      timer = setTimeout(
        () => {
          const c = contactRef.current;
          const lid = localPeerIdRef.current;
          if (!c || !lid) {
            return;
          }
          if (isTransportReady(c.peerId)) {
            return;
          }
          restartSignalingStack(c, lid);
          scheduleReannounce();
        },
        Math.min(SIGNALING_REANNOUNCE_MS, remaining),
      );
    };

    scheduleReannounce();
    return () => clearTimeout(timer);
  }, [
    contact?.conversationId,
    contact?.peerId,
    localPeerId,
    signalingReady,
    gaveUp,
  ]);

  useEffect(() => {
    if (!contact || !localPeerId || gaveUp) {
      return;
    }
    if (!signalingReady || isTransportReady(contact.peerId)) {
      return;
    }

    const timer = setTimeout(
      () => cycleConnectingRetryRef.current(),
      CONNECTING_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [
    contact?.conversationId,
    contact?.peerId,
    localPeerId,
    signalingReady,
    retryAttempt,
    gaveUp,
  ]);

  useEffect(() => {
    if (!contact || !localPeerId) {
      return;
    }

    setSignalingLocalPeerId(localPeerId);
    void ensureTrackerSignaling(
      contact.conversationId,
      localPeerId,
      contact.peerId,
    );
    void api.startNetwork();
    void api.subscribeConversation(contact.conversationId);
    void ensureConversationSignaling(contact.conversationId, contact.peerId);

    return () => {
      teardownTrackerSignaling(contact.conversationId);
    };
  }, [contact?.peerId, contact?.conversationId, localPeerId]);

  useEffect(() => {
    if (!contact || !localPeerId) {
      return;
    }

    const attempt = () => {
      if (isTransportReady(contact.peerId)) {
        return;
      }
      const ready =
        isTrackerSignalingReady(contact.conversationId) ||
        overlayConnected;
      if (!ready) {
        return;
      }
      void ensureTextTransport(
        localPeerId,
        contact.peerId,
        contact.conversationId,
      );
    };

    attempt();
    timerRef.current = setInterval(attempt, RETRY_MS);
    const unsubTracker = subscribeTrackerSignalingState(attempt);

    const pending = api.onOverlayPeerConnected((peerId) => {
      if (peerId === contact.peerId) {
        attempt();
      }
    });

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      unsubTracker();
      void pending.then((unlisten) => unlisten());
    };
  }, [
    contact?.peerId,
    contact?.conversationId,
    localPeerId,
    overlayConnected,
  ]);

  if (!contact || !localPeerId) {
    return { phase: "idle", retryAttempt: 1, maxRetries: MAX_CONNECTING_RETRIES };
  }
  if (isTransportReady(contact.peerId)) {
    return {
      phase: "connected",
      retryAttempt,
      maxRetries: MAX_CONNECTING_RETRIES,
    };
  }
  if (gaveUp) {
    return {
      phase: "unreachable",
      retryAttempt,
      maxRetries: MAX_CONNECTING_RETRIES,
    };
  }
  if (signalingReady) {
    return {
      phase: "connecting",
      retryAttempt,
      maxRetries: MAX_CONNECTING_RETRIES,
    };
  }
  return {
    phase: "waiting_signaling",
    retryAttempt,
    maxRetries: MAX_CONNECTING_RETRIES,
  };
}
