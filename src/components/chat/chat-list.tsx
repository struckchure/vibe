import {
  PlusIcon,
  QrCodeIcon,
  UsersIcon,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types/chat";

type ChatListProps = {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddContact: () => void;
  onJoinRoom: () => void;
  onIdentity: () => void;
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatTime(ts?: number) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChatList({
  conversations,
  selectedId,
  onSelect,
  onAddContact,
  onJoinRoom,
  onIdentity,
}: ChatListProps) {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 py-3">
        <h2 className="text-sm font-medium">Chats</h2>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onIdentity}
            aria-label="Identity"
          >
            <QrCodeIcon data-icon="inline-start" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onJoinRoom}
            aria-label="Join room"
          >
            <UsersIcon data-icon="inline-start" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onAddContact}
            aria-label="Add contact"
          >
            <PlusIcon data-icon="inline-start" />
          </Button>
        </div>
      </header>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        <ItemGroup className="gap-0 p-1">
          {conversations.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No conversations yet. Add a contact or join a room.
            </p>
          ) : (
            conversations.map((c) => (
              <Item
                key={c.id}
                size="sm"
                className={cn(
                  "cursor-pointer border-transparent",
                  selectedId === c.id && "bg-muted"
                )}
                onClick={() => onSelect(c.id)}
              >
                <ItemMedia>
                  <Avatar className="size-9">
                    <AvatarFallback>{initials(c.displayName)}</AvatarFallback>
                  </Avatar>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle
                    className={cn(
                      (c.unreadCount ?? 0) > 0 && "font-semibold"
                    )}
                  >
                    {c.displayName}
                  </ItemTitle>
                  <ItemDescription
                    className={cn(
                      "line-clamp-1",
                      (c.unreadCount ?? 0) > 0 &&
                        "font-medium text-foreground"
                    )}
                  >
                    {c.lastMessage ?? "No messages yet"}
                  </ItemDescription>
                </ItemContent>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {c.lastMessageAt ? (
                    <span className="text-[10px] text-muted-foreground">
                      {formatTime(c.lastMessageAt)}
                    </span>
                  ) : null}
                  {(c.unreadCount ?? 0) > 0 ? (
                    <span className="flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                      {c.unreadCount! > 99 ? "99+" : c.unreadCount}
                    </span>
                  ) : null}
                </div>
              </Item>
            ))
          )}
        </ItemGroup>
      </ScrollArea>
    </div>
  );
}
