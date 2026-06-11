import type { ReactNode } from "react";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { CallShell } from "@/components/call/call-shell";
import { ConnectAnswerDialog } from "@/components/chat/connect-answer-dialog";
import { useConnectDeepLink } from "@/hooks/use-connect-deep-link";
import { useNetworkBootstrap } from "@/hooks/use-network-bootstrap";
import { usePeerInviteDeepLink } from "@/hooks/use-peer-invite-deep-link";
import { useTextChat } from "@/hooks/text-chat";
import { contactKeys } from "@/lib/query-keys";
import * as api from "@/lib/tauri";
import { flushPendingMessages } from "@/lib/webrtc";

function AppNetworkHooks() {
  const queryClient = useQueryClient();

  useNetworkBootstrap();
  usePeerInviteDeepLink();
  useConnectDeepLink();
  useTextChat({
    onIncoming: () => {
      queryClient.invalidateQueries({ queryKey: contactKeys.all });
    },
  });

  useEffect(() => {
    const unlisten = api.onNoiseSessionReady((peerId) => {
      void flushPendingMessages(peerId);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  return null;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <>
      <AppNetworkHooks />
      {children}
      <CallShell />
      <ConnectAnswerDialog />
    </>
  );
}
