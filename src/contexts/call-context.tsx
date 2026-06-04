import { createContext, useContext, type ReactNode } from "react";

import { useCall } from "@/hooks/use-call";
import { useConversationsContext } from "@/contexts/conversations-context";

type CallContextValue = ReturnType<typeof useCall>;

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  const { conversations, getLocalPeerId } = useConversationsContext();
  const value = useCall(conversations, getLocalPeerId);
  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCallContext() {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error("useCallContext requires CallProvider");
  }
  return ctx;
}
