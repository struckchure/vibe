import { useMutation } from "@tanstack/react-query";

import * as api from "@/lib/tauri";

import { updatePeerMessages } from "./messages-store";
import type { UseTextChatMarkAsReadProps } from "./types";

/** `useMutation` to mark a contact's conversation as read. */
export function useTextChatMarkAsRead() {
  return useMutation({
    mutationFn: async ({ contact }: UseTextChatMarkAsReadProps) => {
      const readAt = Date.now();
      updatePeerMessages(contact.peerId, (list) => {
        let changed = false;
        const next = list.map((m) => {
          if (!m.outgoing && !m.readAt && m.kind !== "call") {
            changed = true;
            return { ...m, readAt };
          }
          return m;
        });
        return changed ? next : list;
      });
      await api.markConversationRead(contact.peerId);
    },
  });
}
