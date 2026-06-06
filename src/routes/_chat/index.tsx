import { createFileRoute } from "@tanstack/react-router";
import z from "zod";

import { ChatEmpty } from "@/components/chat/chat-empty";
import { ChatList } from "@/components/chat/chat-list";
import { ChatThread } from "@/components/chat/chat-thread";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useOverlayPeers } from "@/hooks/use-overlay-peers";

export const Route = createFileRoute("/_chat/")({
  component: RouteComponent,
  validateSearch: z.object({ id: z.string().optional() }),
});

function RouteComponent() {
  const { id } = Route.useSearch();
  const overlayPeers = useOverlayPeers();
  const isDesktop = useMediaQuery("(min-width: 768px)");

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      {overlayPeers === 0 && (
        <p className="shrink-0 border-b bg-muted/50 px-4 py-2 text-center text-xs text-muted-foreground">
          Offline — you can still send messages; they will deliver when you
          reconnect. Join a room or add a contact via QR to get on the network.
        </p>
      )}

      {isDesktop ? (
        <ResizablePanelGroup
          orientation="horizontal"
          className="h-full min-h-0 w-full"
        >
          <ResizablePanel
            id="chat-list"
            defaultSize="25%"
            minSize="15%"
            maxSize="30%"
          >
            <ChatList />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="chat-thread" minSize="70%">
            {id ? <ChatThread key={id} id={id} /> : <ChatEmpty />}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : id ? (
        <ChatThread key={id} id={id} />
      ) : (
        <div className="h-full min-h-0 w-full min-w-0">
          <ChatList />
        </div>
      )}
    </div>
  );
}
