import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { CallShell } from "@/components/call/call-shell";
import { useNetworkBootstrap } from "@/hooks/use-network-bootstrap";
import { usePeerInviteDeepLink } from "@/hooks/use-peer-invite-deep-link";
import { useTextChat } from "@/hooks/text-chat";
import { contactKeys } from "@/lib/query-keys";

function AppNetworkHooks() {
  const queryClient = useQueryClient();

  useNetworkBootstrap();
  usePeerInviteDeepLink();
  useTextChat({
    onIncoming: () => {
      queryClient.invalidateQueries({ queryKey: contactKeys.all });
    },
  });
  return null;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <>
      <AppNetworkHooks />
      {children}
      <CallShell />
    </>
  );
}
