import {
  ArrowLeftIcon,
  CheckCheckIcon,
  CheckIcon,
  ClockIcon,
  MoreVerticalIcon,
  PhoneIcon,
  PhoneMissedIcon,
  SendIcon,
  Trash2Icon,
  VideoIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
import { isCallMessage } from "@/lib/call-history";
import { cn } from "@/lib/utils";
import type { Conversation, Message } from "@/types/chat";

type ChatThreadProps = {
  conversation: Conversation;
  messages: Message[];
  onSend: (body: string) => Promise<void>;
  onBack?: () => void;
  onRemoveContact?: () => Promise<void>;
  onVoiceCall?: () => void;
  onVideoCall?: () => void;
  callBusy?: boolean;
  transport?: "direct" | "network";
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function ChatThread({
  conversation,
  messages,
  onSend,
  onBack,
  onRemoveContact,
  onVoiceCall,
  onVideoCall,
  callBusy = false,
  transport = "network",
}: ChatThreadProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [removing, setRemoving] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    const previousDraft = draft;
    setDraft("");
    try {
      await onSend(text);
    } catch (e) {
      setDraft(previousDraft);
      toast.error(String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 sticky top-2 bg-background z-10">
        {onBack ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            aria-label="Back to chats"
          >
            <ArrowLeftIcon data-icon="inline-start" />
          </Button>
        ) : null}
        <Avatar className="size-10">
          <AvatarFallback>{initials(conversation.displayName)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">
            {conversation.displayName}
          </span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {conversation.peerId.slice(0, 16)}…
          </span>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            transport === "direct"
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {transport === "direct" ? "Direct" : "Network"}
        </span>
        {onVoiceCall ? (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={callBusy}
            onClick={onVoiceCall}
            aria-label="Voice call"
            title={
              transport === "network"
                ? "Voice call (via network signaling)"
                : "Voice call"
            }
          >
            <PhoneIcon data-icon="inline-start" />
          </Button>
        ) : null}
        {onVideoCall ? (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={callBusy}
            onClick={onVideoCall}
            aria-label="Video call"
            title={
              transport === "network"
                ? "Video call (via network signaling)"
                : "Video call"
            }
          >
            <VideoIcon data-icon="inline-start" />
          </Button>
        ) : null}
        {onRemoveContact ? (
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
                  {conversation.displayName} will be removed from your contacts
                  and this chat history will be cleared from this device.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={removing}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-white hover:bg-destructive/90"
                  disabled={removing}
                  onClick={(e) => {
                    e.preventDefault();
                    setRemoving(true);
                    void onRemoveContact()
                      .then(() => toast.success("Contact removed"))
                      .catch((err) => toast.error(String(err)))
                      .finally(() => setRemoving(false));
                  }}
                >
                  {removing ? <Spinner /> : "Delete"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-4">
          {messages.map((msg) =>
            isCallMessage(msg) ? (
              <div key={msg.id} className="flex justify-center py-1">
                <div
                  className={cn(
                    "flex max-w-[85%] items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-muted-foreground",
                    (msg.callOutcome === "missed" ||
                      msg.callOutcome === "declined") &&
                      "text-destructive/90",
                  )}
                >
                  {msg.callOutcome === "missed" ||
                  msg.callOutcome === "declined" ? (
                    <PhoneMissedIcon className="size-3.5 shrink-0" />
                  ) : msg.callMedia === "video" ? (
                    <VideoIcon className="size-3.5 shrink-0" />
                  ) : (
                    <PhoneIcon className="size-3.5 shrink-0" />
                  )}
                  <span>{msg.body}</span>
                </div>
              </div>
            ) : (
              <div
                key={msg.id}
                className={cn(
                  "flex",
                  msg.outgoing ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "flex max-w-[75%] items-end gap-1 rounded-md px-3 py-2 text-xs",
                    msg.outgoing
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground",
                  )}
                >
                  <span className="min-w-0 flex-1">{msg.body}</span>
                  {msg.outgoing ? (
                    <span
                      className={cn(
                        "shrink-0 opacity-70",
                        msg.readAt && "text-primary-foreground",
                      )}
                      title={
                        msg.pending
                          ? "Waiting to send"
                          : msg.readAt
                            ? "Read"
                            : msg.deliveredAt
                              ? "Delivered"
                              : "Sent"
                      }
                    >
                      {msg.pending ? (
                        <ClockIcon className="size-3" />
                      ) : msg.readAt || msg.deliveredAt ? (
                        <CheckCheckIcon
                          className={cn("size-3", msg.readAt && "opacity-100")}
                        />
                      ) : (
                        <CheckIcon className="size-3" />
                      )}
                    </span>
                  ) : null}
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
                void handleSend();
              }
            }}
          />
          <InputGroupAddon align="block-end">
            <InputGroupButton
              variant="default"
              disabled={sending || !draft.trim()}
              onClick={() => void handleSend()}
            >
              {sending ? <Spinner /> : <SendIcon data-icon="inline-start" />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
}
