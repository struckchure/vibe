import { useMutation } from "@tanstack/react-query";

import * as api from "@/lib/tauri";

import type { UseRemoveContactProps } from "./types";

/** `useMutation` for removing a peer. Caller invalidates {@link contactKeys.all} when needed. */
export function useRemoveContact() {
  return useMutation({
    mutationFn: async (props: UseRemoveContactProps) => {
      await api.removeContact(props.peerId);
    },
  });
}
