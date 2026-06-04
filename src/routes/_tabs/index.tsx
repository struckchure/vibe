import { createFileRoute } from "@tanstack/react-router";

import { ChatLayout } from "@/components/chat/chat-layout";

export const Route = createFileRoute("/_tabs/")({
  component: Index,
});

function Index() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <ChatLayout />
    </div>
  );
}
