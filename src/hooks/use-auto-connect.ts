import { useEffect, useRef } from "react";

import type { Contact } from "@/lib/tauri";
import * as api from "@/lib/tauri";
import {
  ensureTextTransport,
  isTransportReady,
  setSignalingLocalPeerId,
} from "@/lib/webrtc";
import { ensureConversationSignaling } from "@/lib/transport/signaling";
import { useContactOverlayConnected } from "@/hooks/use-overlay-peers";

const RETRY_MS = 2000;

export type AutoConnectPhase =
  | "connected"
  | "connecting"
  | "waiting_overlay"
  | "idle";

export function useAutoConnect(
  contact: Contact | undefined,
  localPeerId: string | undefined,
): AutoConnectPhase {
  const overlayConnected = useContactOverlayConnected(contact?.peerId);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!contact || !localPeerId) {
      return;
    }

    setSignalingLocalPeerId(localPeerId);
    void api.subscribeConversation(contact.conversationId);
    void ensureConversationSignaling(contact.conversationId, contact.peerId);

    const attempt = () => {
      if (isTransportReady(contact.peerId)) {
        return;
      }
      if (!overlayConnected) {
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

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [
    contact?.peerId,
    contact?.conversationId,
    localPeerId,
    overlayConnected,
  ]);

  if (!contact || !localPeerId) {
    return "idle";
  }
  if (isTransportReady(contact.peerId)) {
    return "connected";
  }
  if (overlayConnected) {
    return "connecting";
  }
  return "waiting_overlay";
}
