import type { ReactNode } from "react";

import { CallShell } from "@/components/call/call-shell";
import { CallProvider } from "@/contexts/call-context";
import { ConversationsProvider } from "@/contexts/conversations-context";
import { useNetworkBootstrap } from "@/hooks/use-network-bootstrap";
import { usePeerInviteDeepLink } from "@/hooks/use-peer-invite-deep-link";

function AppNetworkHooks() {
  useNetworkBootstrap();
  usePeerInviteDeepLink();
  return null;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ConversationsProvider>
      <CallProvider>
        <AppNetworkHooks />
        {children}
        <CallShell />
      </CallProvider>
    </ConversationsProvider>
  );
}
