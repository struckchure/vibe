import { MessageSquareIcon } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export function ChatEmpty() {
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessageSquareIcon />
        </EmptyMedia>
        <EmptyTitle>Select a chat</EmptyTitle>
        <EmptyDescription>
          Choose a conversation from the list or add a contact to start
          messaging.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
