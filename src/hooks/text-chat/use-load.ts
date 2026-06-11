import { useMutation } from "@tanstack/react-query";
import { startTransition } from "react";

import * as api from "@/lib/tauri";

import { mergeMessage, updatePeerMessages } from "./messages-store";
import type { UseTextChatLoadProps } from "./types";

/** `useMutation` to load and merge message history for a contact. */
export function useTextChatLoad() {
  return useMutation({
    mutationFn: async ({ contact }: UseTextChatLoadProps) => {
      const msgs = await api.listMessages(contact.peerId);
      startTransition(() => {
        updatePeerMessages(contact.peerId, (existing) => {
          if (!existing.length) {
            return msgs;
          }
          const localById = new Map(existing.map((m) => [m.id, m]));
          let changed = existing.length !== msgs.length;
          const merged = msgs.map((server) => {
            const local = localById.get(server.id);
            const next = mergeMessage(local, server);
            if (
              local &&
              local.readAt === next.readAt &&
              local.deliveredAt === next.deliveredAt &&
              local.body === next.body
            ) {
              return local;
            }
            changed = true;
            return next;
          });
          return changed ? merged : existing;
        });
      });
    },
  });
}
