import {
  ArrowLeftIcon,
  CheckCheckIcon,
  CheckIcon,
  ClockIcon,
  LinkIcon,
  MoreVerticalIcon,
  PhoneIcon,
  PhoneMissedIcon,
  SendIcon,
  Trash2Icon,
  VideoIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { platform } from "@tauri-apps/plugin-os";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { useListContacts, useLocalPeerId } from "@/hooks/contacts";
import {
  useTextChat,
  useTextChatLoad,
  useTextChatMarkAsRead,
  useTextChatRemoveContact,
  useTextChatSend,
} from "@/hooks/text-chat";
import { ConnectDialog } from "@/components/chat/connect-dialog";
import { useAutoConnect } from "@/hooks/use-auto-connect";
import { useVideoChat, useVoiceChat } from "@/hooks/use-voice-chat";
import { isCallMessage } from "@/lib/call-history";
import { contactKeys } from "@/lib/query-keys";
import { isTextChannelOpen } from "@/lib/webrtc";
import { cn } from "@/lib/utils";

type ChatThreadProps = {
  id: string;
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

const routeApi = getRouteApi("/_chat/");

export function ChatThread({ id }: ChatThreadProps) {
  const currentPlatform = platform();
  const navigate = routeApi.useNavigate();
  const queryClient = useQueryClient();

  const listContactQuery = useListContacts();
  const localPeerIdQuery = useLocalPeerId();
  const textChat = useTextChat();
  const loadTextChatMutation = useTextChatLoad();
  const sendTextChatMutation = useTextChatSend();
  const markTextChatAsReadMutation = useTextChatMarkAsRead();
  const removeContactMutation = useTextChatRemoveContact();
  const voice = useVoiceChat();
  const video = useVideoChat();

  const contact = useMemo(
    () => listContactQuery.data?.find((c) => c.conversationId === id),
    [listContactQuery.data, id],
  );
  const [draft, setDraft] = useState("");
  const [connectOpen, setConnectOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = contact
    ? (textChat.messagesByPeer[contact.peerId] ?? [])
    : [];
  const callBusy = voice.isBusy || video.isBusy;
  const autoConnectPhase = useAutoConnect(contact, localPeerIdQuery.data);
  const channelOpen =
    !!contact &&
    (textChat.isChannelOpen({ contact }) || isTextChannelOpen(contact.peerId));
  const transport = channelOpen
    ? ("direct" as const)
    : autoConnectPhase === "connecting"
      ? ("connecting" as const)
      : ("offline" as const);

  useEffect(() => {
    if (!contact) {
      return;
    }
    loadTextChatMutation.mutate(
      { contact },
      {
        onSuccess: () => {
          markTextChatAsReadMutation.mutate(
            { contact },
            {
              onSuccess: () => {
                queryClient.invalidateQueries({ queryKey: contactKeys.all });
              },
            },
          );
        },
      },
    );
  }, [contact?.peerId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSend() {
    if (!contact) {
      return;
    }
    const body = draft.trim();
    if (!body) {
      return;
    }
    sendTextChatMutation.mutate(
      { contact, body },
      {
        onSuccess: () => {
          setDraft("");
          queryClient.invalidateQueries({ queryKey: contactKeys.all });
        },
      },
    );
  }

  function handleRemoveContact() {
    if (!contact) {
      return;
    }
    removeContactMutation.mutate(
      { contact },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: contactKeys.all });
          navigate({ search: {} });
        },
      },
    );
  }

  if (!contact) {
    return null;
  }

  return (
    <div className="flex h-full flex-col">
      {!channelOpen && autoConnectPhase === "waiting_overlay" && (
        <p className="shrink-0 border-b bg-muted/50 px-4 py-2 text-center text-xs text-muted-foreground">
          Waiting for {contact.displayName} on the libp2p overlay — open this chat
          on both devices once you are connected peers.
        </p>
      )}
      {!channelOpen && autoConnectPhase === "connecting" && (
        <p className="shrink-0 border-b bg-primary/10 px-4 py-2 text-center text-xs text-primary">
          Connecting to {contact.displayName}…
        </p>
      )}
      {!channelOpen && autoConnectPhase === "idle" && (
        <p className="shrink-0 border-b bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-800 dark:text-amber-200">
          Not connected — messages queue until the data channel is open. Use
          Advanced → manual connect link if overlay connect does not work.
        </p>
      )}
      <header
        className={cn(
          "flex shrink-0 items-center gap-3 border-b px-4 py-1.5",
          ["ios", "android"].includes(currentPlatform) &&
            "sticky top-2 z-10 bg-background",
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => navigate({ search: {} })}
          aria-label="Back to chats"
        >
          <ArrowLeftIcon data-icon="inline-start" />
        </Button>
        <Avatar className="size-10">
          <AvatarFallback>{initials(contact.displayName)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">
            {contact.displayName}
          </span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {contact.peerId.slice(0, 16)}…
          </span>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            transport === "direct"
              ? "bg-primary/10 text-primary"
              : transport === "connecting"
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground",
          )}
        >
          {transport === "direct"
            ? "Direct"
            : transport === "connecting"
              ? "Connecting"
              : "Offline"}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={callBusy || !channelOpen}
          onClick={() => voice.start({ contact })}
          aria-label="Voice call"
        >
          <PhoneIcon data-icon="inline-start" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={callBusy || !channelOpen}
          onClick={() => video.start({ contact })}
          aria-label="Video call"
        >
          <VideoIcon data-icon="inline-start" />
        </Button>
        <AlertDialog>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Conversation options"
              >
                <MoreVerticalIcon data-icon="inline-start" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setConnectOpen(true)}>
                <LinkIcon data-icon="inline-start" />
                Advanced: manual connect link
              </DropdownMenuItem>
              <AlertDialogTrigger asChild>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={(e) => e.preventDefault()}
                >
                  <Trash2Icon data-icon="inline-start" />
                  Delete contact
                </DropdownMenuItem>
              </AlertDialogTrigger>
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete contact?</AlertDialogTitle>
              <AlertDialogDescription>
                {contact.displayName} will be removed from your contacts and
                this chat history will be cleared from this device.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={removeContactMutation.isPending}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                disabled={removeContactMutation.isPending}
                onClick={handleRemoveContact}
              >
                {removeContactMutation.isPending ? <Spinner /> : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-4">
          {messages.map((message) =>
            isCallMessage(message) ? (
              <div key={message.id} className="flex justify-center py-1">
                <div
                  className={cn(
                    "flex max-w-[85%] items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-muted-foreground",
                    (message.callOutcome === "missed" ||
                      message.callOutcome === "declined") &&
                      "text-destructive/90",
                  )}
                >
                  {message.callOutcome === "missed" ||
                  message.callOutcome === "declined" ? (
                    <PhoneMissedIcon className="size-3.5 shrink-0" />
                  ) : message.callMedia === "video" ? (
                    <VideoIcon className="size-3.5 shrink-0" />
                  ) : (
                    <PhoneIcon className="size-3.5 shrink-0" />
                  )}
                  <span>{message.body}</span>
                </div>
              </div>
            ) : (
              <div
                key={message.id}
                className={cn(
                  "flex",
                  message.outgoing ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "flex max-w-[75%] items-end gap-1 rounded-md px-3 py-2 text-xs",
                    message.outgoing
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground",
                  )}
                >
                  <span className="min-w-0 flex-1">{message.body}</span>
                  {message.outgoing && (
                    <span
                      className={cn(
                        "shrink-0 opacity-70",
                        message.readAt && "text-primary-foreground",
                      )}
                      title={
                        message.pending
                          ? "Waiting to send"
                          : message.readAt
                            ? "Read"
                            : message.deliveredAt
                              ? "Delivered"
                              : "Sent"
                      }
                    >
                      {message.pending ? (
                        <ClockIcon className="size-3" />
                      ) : message.readAt || message.deliveredAt ? (
                        <CheckCheckIcon
                          className={cn(
                            "size-3",
                            message.readAt && "opacity-100",
                          )}
                        />
                      ) : (
                        <CheckIcon className="size-3" />
                      )}
                    </span>
                  )}
                </div>
              </div>
            ),
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <Separator />
      <div className="shrink-0 p-3">
        <InputGroup className="h-auto min-h-10">
          <InputGroupTextarea
            placeholder="Type a message"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <InputGroupAddon align="block-end">
            <InputGroupButton
              variant="default"
              disabled={sendTextChatMutation.isPending || !draft.trim()}
              onClick={handleSend}
            >
              {sendTextChatMutation.isPending ? (
                <Spinner />
              ) : (
                <SendIcon data-icon="inline-start" />
              )}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>

      {localPeerIdQuery.data && (
        <ConnectDialog
          open={connectOpen}
          onOpenChange={setConnectOpen}
          contact={contact}
          localPeerId={localPeerIdQuery.data}
        />
      )}
    </div>
  );
}
