import { createContext, useContext, type ReactNode } from "react";

import { useConversations } from "@/hooks/use-conversations";

type ConversationsContextValue = ReturnType<typeof useConversations>;

const ConversationsContext = createContext<ConversationsContextValue | null>(
  null
);

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const value = useConversations();
  return (
    <ConversationsContext.Provider value={value}>
      {children}
    </ConversationsContext.Provider>
  );
}

export function useConversationsContext() {
  const ctx = useContext(ConversationsContext);
  if (!ctx) {
    throw new Error("useConversationsContext requires ConversationsProvider");
  }
  return ctx;
}
