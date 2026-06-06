import { useMutation } from "@tanstack/react-query";

import { useLocalPeerId } from "@/hooks/contacts";
import * as api from "@/lib/tauri";
import { sendTextMessage } from "@/lib/webrtc";

import { updatePeerMessages } from "./messages-store";
import type { UseTextChatSendProps } from "./types";

/** `useMutation` to send a text message to a contact. */
export function useTextChatSend() {
  const localPeerIdQuery = useLocalPeerId();

  return useMutation({
    mutationFn: async ({ contact, body }: UseTextChatSendProps) => {
      const localPeerId =
        localPeerIdQuery.data ?? (await api.getPeerId());
      await api.startNetwork();
      const { message } = await sendTextMessage(
        localPeerId,
        contact.peerId,
        contact.conversationId,
        body
      );
      updatePeerMessages(contact.peerId, (list) => [...list, message]);
      return message;
    },
  });
}
