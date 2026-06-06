import { useMutation } from "@tanstack/react-query";

import * as api from "@/lib/tauri";

import type { UseAddContactProps } from "./types";

/** `useMutation` for adding a peer. Caller invalidates {@link contactKeys.all} when needed. */
export function useAddContact() {
  return useMutation({
    mutationFn: async (props: UseAddContactProps) => {
      await api.addContact(props.peerId, props.displayName);
    },
  });
}
