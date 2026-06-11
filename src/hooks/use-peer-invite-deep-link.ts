import { useEffect, useRef } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useAddContact } from "@/hooks/contacts";
import { parsePeerInviteUrl } from "@/lib/peer-id";
import { contactKeys } from "@/lib/query-keys";

export function usePeerInviteDeepLink() {
  const addContactMutation = useAddContact();
  const queryClient = useQueryClient();
  const processed = useRef(new Set<string>());

  useEffect(() => {
    function handleUrl(url: string) {
      const invite = parsePeerInviteUrl(url);
      if (!invite || processed.current.has(invite.peerId)) return;
      processed.current.add(invite.peerId);

      addContactMutation.mutate(
        {
          peerId: invite.peerId,
          displayName: `Contact ${invite.peerId.slice(0, 8)}`,
          dialAddrs: invite.dialAddrs.length > 0 ? invite.dialAddrs : undefined,
        },
        {
          onSuccess: () => {
            toast.success("Contact added from link");
            queryClient.invalidateQueries({ queryKey: contactKeys.all });
          },
          onError: () => {
            processed.current.delete(invite.peerId);
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
  }, [addContactMutation, queryClient]);
}
