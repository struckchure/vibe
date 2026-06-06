import { PlusIcon, QrCodeIcon, UsersIcon } from "lucide-react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { DiscoveryDialogs } from "@/components/chat/discovery-dialogs";
import { IdentityDialog } from "@/components/chat/identity-dialog";
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
import { Spinner } from "@/components/ui/spinner";
import { useListContacts } from "@/hooks/contacts";
import { contactKeys } from "@/lib/query-keys";
import * as api from "@/lib/tauri";
import { cn } from "@/lib/utils";

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatTime(ts?: number | null) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const routeApi = getRouteApi("/_chat/");

export function ChatList() {
  const { id } = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const queryClient = useQueryClient();
  const listContactQuery = useListContacts();
  const contacts = listContactQuery.data ?? [];
  const isPending = listContactQuery.isPending;

  const [addContactOpen, setAddContactOpen] = useState(false);
  const [joinRoomOpen, setJoinRoomOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);

  const contactPeerIds = useMemo(
    () => new Set(contacts.map((c) => c.peerId)),
    [contacts],
  );

  useEffect(() => {
    const unlisten = api.onIdentityChanged(() => {
      navigate({ search: {} });
      queryClient.invalidateQueries({ queryKey: contactKeys.all });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [navigate, queryClient]);

  function handleIdentityChanged() {
    navigate({ search: {} });
    queryClient.invalidateQueries({ queryKey: contactKeys.all });
  }

  return (
    <>
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-2 px-3 py-3">
          <h2 className="text-sm font-medium">Chats</h2>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setIdentityOpen(true)}
              aria-label="Identity"
            >
              <QrCodeIcon data-icon="inline-start" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setJoinRoomOpen(true)}
              aria-label="Join room"
            >
              <UsersIcon data-icon="inline-start" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setAddContactOpen(true)}
              aria-label="Add contact"
            >
              <PlusIcon data-icon="inline-start" />
            </Button>
          </div>
        </header>

        <Separator />

        <ScrollArea className="min-h-0 flex-1">
          <ItemGroup className="gap-0 p-1">
            {isPending ? (
              <div className="flex justify-center py-12">
                <Spinner />
              </div>
            ) : contacts.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No conversations yet. Add a contact or join a room.
              </p>
            ) : (
              contacts.map((c) => (
                <Link
                  key={c.conversationId}
                  to="/"
                  search={{ id: c.conversationId }}
                >
                  <Item
                    size="sm"
                    className={cn(
                      "cursor-pointer border-transparent",
                      id === c.conversationId && "bg-muted",
                    )}
                  >
                    <ItemMedia>
                      <Avatar className="size-9">
                        <AvatarFallback>
                          {initials(c.displayName)}
                        </AvatarFallback>
                      </Avatar>
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle
                        className={cn(c.unreadCount > 0 && "font-semibold")}
                      >
                        {c.displayName}
                      </ItemTitle>
                      <ItemDescription
                        className={cn(
                          "line-clamp-1",
                          c.unreadCount > 0 && "font-medium text-foreground",
                        )}
                      >
                        {c.lastMessage ?? "No messages yet"}
                      </ItemDescription>
                    </ItemContent>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {c.lastMessageAt && (
                        <span className="text-[10px] text-muted-foreground">
                          {formatTime(c.lastMessageAt)}
                        </span>
                      )}
                      {c.unreadCount > 0 && (
                        <span className="flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                          {c.unreadCount > 99 ? "99+" : c.unreadCount}
                        </span>
                      )}
                    </div>
                  </Item>
                </Link>
              ))
            )}
          </ItemGroup>
        </ScrollArea>
      </div>

      <IdentityDialog
        open={identityOpen}
        onOpenChange={setIdentityOpen}
        onIdentityChanged={handleIdentityChanged}
      />

      <DiscoveryDialogs
        addContactOpen={addContactOpen}
        onAddContactOpenChange={setAddContactOpen}
        joinRoomOpen={joinRoomOpen}
        onJoinRoomOpenChange={setJoinRoomOpen}
        contactPeerIds={contactPeerIds}
      />
    </>
  );
}
