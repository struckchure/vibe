import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { formatConnectError } from "@/lib/connect-errors";
import { processConnectInput } from "@/lib/connect-handler";
import { setConnectAnswerPrompt } from "@/lib/connect-answer-prompt";
import { connectUriFingerprint, isConnectUri } from "@/lib/connect-uri";
import { contactKeys } from "@/lib/query-keys";
import * as api from "@/lib/tauri";

export function useConnectDeepLink() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const processed = useRef(new Set<string>());

  useEffect(() => {
    async function handleUrl(url: string) {
      if (!isConnectUri(url)) {
        return;
      }

      const fingerprint = connectUriFingerprint(url);
      if (!fingerprint || processed.current.has(fingerprint)) {
        return;
      }

      processed.current.add(fingerprint);

      try {
        const localPeerId = await api.getPeerId();
        const result = await processConnectInput(url, localPeerId);

        if (result.status === "answer_ready") {
          setConnectAnswerPrompt({
            answerUri: result.answerUri,
            remoteDisplayName: result.remoteDisplayName,
            conversationId: result.conversationId,
          });
          toast.success(
            `Send the answer link back to ${result.remoteDisplayName}`,
          );
          void navigate({
            to: "/",
            search: { id: result.conversationId },
          });
          queryClient.invalidateQueries({ queryKey: contactKeys.all });
          return;
        }

        if (result.status === "connected") {
          toast.success("Connected");
          void navigate({
            to: "/",
            search: { id: result.conversationId },
          });
          queryClient.invalidateQueries({ queryKey: contactKeys.all });
          return;
        }

        toast.error("Couldn't connect", { description: result.message });
        processed.current.delete(fingerprint);
      } catch (err) {
        toast.error("Couldn't connect", {
          description: formatConnectError(err),
        });
        processed.current.delete(fingerprint);
      }
    }

    getCurrent().then((urls) => {
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
      pending.then((unlisten) => unlisten());
    };
  }, [navigate, queryClient]);
}
