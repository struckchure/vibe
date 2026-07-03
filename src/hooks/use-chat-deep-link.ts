import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useListContacts } from "@/hooks/contacts";
import { parseChatDeepLink } from "@/lib/chat-deep-link";
import { contactKeys } from "@/lib/query-keys";

export function useChatDeepLink() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const listContactQuery = useListContacts();
  const processed = useRef(new Set<string>());
  const contactsRef = useRef(listContactQuery.data);
  contactsRef.current = listContactQuery.data;

  useEffect(() => {
    function handleUrl(url: string) {
      const conversationId = parseChatDeepLink(url);
      if (!conversationId || processed.current.has(conversationId)) {
        return;
      }
      processed.current.add(conversationId);

      const contact = contactsRef.current?.find(
        (c) => c.conversationId === conversationId,
      );
      if (!contact) {
        toast.error("Unknown chat", {
          description: "Add this contact before opening the chat link.",
        });
        processed.current.delete(conversationId);
        return;
      }

      void navigate({ to: "/", search: { id: conversationId } });
      queryClient.invalidateQueries({ queryKey: contactKeys.all });
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
  }, [navigate, queryClient]);
}
