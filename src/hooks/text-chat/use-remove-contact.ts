import { useMutation } from "@tanstack/react-query";

import { endCall, isCallBusy } from "@/lib/calls";
import * as api from "@/lib/tauri";
import { closeTextTransport } from "@/lib/webrtc";

import type { UseTextChatRemoveContactProps } from "./types";

/** `useMutation` to remove a contact and tear down text transport and any active call. */
export function useTextChatRemoveContact() {
  return useMutation({
    mutationFn: async ({ contact }: UseTextChatRemoveContactProps) => {
      if (isCallBusy()) {
        await endCall();
      }
      closeTextTransport(contact.peerId);
      await api.removeContact(contact.peerId);
    },
  });
}
