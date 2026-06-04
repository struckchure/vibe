import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";

import type { Conversation } from "@/types/chat";
import type { CallMedia } from "@/types/call";
import * as api from "@/lib/tauri";
import {
  acceptCall,
  declineCall,
  endCall,
  getCallSnapshot,
  isCallBusy,
  setupCallSignaling,
  startCall,
  subscribeCallState,
  toggleCamera,
  toggleMute,
} from "@/lib/calls";

export function useCall(
  conversations: Conversation[],
  getLocalPeerId: () => Promise<string>
) {
  const snapshot = useSyncExternalStore(
    subscribeCallState,
    getCallSnapshot,
    getCallSnapshot
  );

  const contactsKey = useMemo(
    () =>
      conversations
        .map((c) => `${c.id}:${c.peerId}:${c.displayName}`)
        .join("|"),
    [conversations]
  );

  useEffect(() => {
    void (async () => {
      await api.startNetwork();
      const localId = await getLocalPeerId();
      await setupCallSignaling(
        localId,
        conversations.map((c) => ({
          peerId: c.peerId,
          displayName: c.displayName,
          conversationId: c.id,
        }))
      );
    })();
  }, [contactsKey, conversations, getLocalPeerId]);

  const placeCall = useCallback(
    async (contact: Conversation, media: CallMedia) => {
      if (isCallBusy()) {
        toast.error("Already in a call");
        return;
      }
      try {
        const localId = await getLocalPeerId();
        await startCall(localId, {
          peerId: contact.peerId,
          displayName: contact.displayName,
          conversationId: contact.id,
        }, media);
      } catch (e) {
        const msg =
          e instanceof Error ? e.message : String(e);
        toast.error(msg || "Could not start call");
      }
    },
    [getLocalPeerId]
  );

  const startVoiceCall = useCallback(
    (contact: Conversation) => placeCall(contact, "audio"),
    [placeCall]
  );

  const startVideoCall = useCallback(
    (contact: Conversation) => placeCall(contact, "video"),
    [placeCall]
  );

  const handleAccept = useCallback(async () => {
    try {
      const localId = await getLocalPeerId();
      await acceptCall(localId);
    } catch (e) {
      toast.error(String(e));
    }
  }, [getLocalPeerId]);

  const handleDecline = useCallback(async () => {
    await declineCall();
    toast.message("Call declined");
  }, []);

  const handleEnd = useCallback(async () => {
    await endCall();
  }, []);

  const handleToggleMute = useCallback(() => {
    toggleMute();
  }, []);

  const handleToggleCamera = useCallback(() => {
    toggleCamera();
  }, []);

  return useMemo(
    () => ({
      ...snapshot,
      isBusy: isCallBusy(),
      startVoiceCall,
      startVideoCall,
      acceptCall: handleAccept,
      declineCall: handleDecline,
      endCall: handleEnd,
      toggleMute: handleToggleMute,
      toggleCamera: handleToggleCamera,
    }),
    [
      snapshot,
      startVoiceCall,
      startVideoCall,
      handleAccept,
      handleDecline,
      handleEnd,
      handleToggleMute,
      handleToggleCamera,
    ]
  );
}
