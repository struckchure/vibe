import type { ReactNode } from "react";

import { CallShell } from "@/components/call/call-shell";
import { CallProvider } from "@/contexts/call-context";
import { ConversationsProvider } from "@/contexts/conversations-context";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ConversationsProvider>
      <CallProvider>
        {children}
        <CallShell />
      </CallProvider>
    </ConversationsProvider>
  );
}
