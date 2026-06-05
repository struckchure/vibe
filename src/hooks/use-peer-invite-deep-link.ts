import { useCallback, useEffect, useRef } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { toast } from "sonner";

import { useConversationsContext } from "@/contexts/conversations-context";
import { parsePeerInviteUrl } from "@/lib/peer-id";
import * as api from "@/lib/tauri";

export function usePeerInviteDeepLink() {
  const { refreshContacts } = useConversationsContext();
  const processed = useRef(new Set<string>());

  const handleUrl = useCallback(
    async (url: string) => {
      const peerId = parsePeerInviteUrl(url);
      if (!peerId || processed.current.has(peerId)) return;
      processed.current.add(peerId);
      try {
        await api.addContact(peerId, `Contact ${peerId.slice(0, 8)}`);
        toast.success("Contact added from link");
        await refreshContacts();
      } catch (e) {
        processed.current.delete(peerId);
        toast.error(String(e));
      }
    },
    [refreshContacts],
  );

  useEffect(() => {
    void getCurrent().then((urls) => {
      for (const url of urls ?? []) {
        void handleUrl(url);
      }
    });
    const pending = onOpenUrl((urls) => {
      for (const url of urls) {
        void handleUrl(url);
      }
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [handleUrl]);
}
