import { useEffect, useRef } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useAddContact } from "@/hooks/contacts";
import { parsePeerInviteUrl } from "@/lib/peer-id";
import { contactKeys } from "@/lib/query-keys";

export function usePeerInviteDeepLink() {
  const addContact = useAddContact();
  const queryClient = useQueryClient();
  const processed = useRef(new Set<string>());

  useEffect(() => {
    function handleUrl(url: string) {
      const peerId = parsePeerInviteUrl(url);
      if (!peerId || processed.current.has(peerId)) return;
      processed.current.add(peerId);

      addContact.mutate(
        {
          peerId,
          displayName: `Contact ${peerId.slice(0, 8)}`,
        },
        {
          onSuccess: () => {
            toast.success("Contact added from link");
            queryClient.invalidateQueries({ queryKey: contactKeys.all });
          },
          onError: () => {
            processed.current.delete(peerId);
          },
        },
      );
    }

    getCurrent().then((urls) => {
      for (const url of urls ?? []) {
        handleUrl(url);
      }
    });
    const pending = onOpenUrl((urls) => {
      for (const url of urls) {
        handleUrl(url);
      }
    });
    return () => {
      pending.then((unlisten) => unlisten());
    };
  }, [addContact, queryClient]);
}
