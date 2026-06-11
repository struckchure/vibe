import { useMutation } from "@tanstack/react-query";

import { useLocalPeerId } from "@/hooks/contacts";
import type { Message } from "@/types/chat";
import * as api from "@/lib/tauri";
import { sendTextMessage } from "@/lib/webrtc";

import { updatePeerMessages, upsertMessage } from "./messages-store";
import type { UseTextChatSendProps } from "./types";

function optimisticMessage(contact: UseTextChatSendProps["contact"], body: string): Message {
  return {
    id: `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    conversationId: contact.conversationId,
    peerId: contact.peerId,
    body,
    sentAt: Date.now(),
    outgoing: true,
    pending: true,
    kind: "text",
  };
}

/** `useMutation` to send a text message to a contact. */
export function useTextChatSend() {
  const localPeerIdQuery = useLocalPeerId();

  return useMutation({
    mutationFn: async ({ contact, body }: UseTextChatSendProps) => {
      const localPeerId =
        localPeerIdQuery.data ?? (await api.getPeerId());
      const { message } = await sendTextMessage(
        localPeerId,
        contact.peerId,
        contact.conversationId,
        body
      );
      return message;
    },
    onMutate: ({ contact, body }) => {
      const optimistic = optimisticMessage(contact, body);
      updatePeerMessages(contact.peerId, (list) => [...list, optimistic]);
      return { optimisticId: optimistic.id };
    },
    onSuccess: (message, { contact }, context) => {
      updatePeerMessages(contact.peerId, (list) => {
        const withoutOptimistic = context?.optimisticId
          ? list.filter((m) => m.id !== context.optimisticId)
          : list;
        return upsertMessage(withoutOptimistic, message);
      });
    },
    onError: (_error, { contact }, context) => {
      if (!context?.optimisticId) {
        return;
      }
      updatePeerMessages(contact.peerId, (list) =>
        list.filter((m) => m.id !== context.optimisticId)
      );
    },
  });
}
