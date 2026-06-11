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
import { useContactReachability } from "@/hooks/use-contact-reachability";
import { useOverlayPeers } from "@/hooks/use-overlay-peers";
import { useListContacts } from "@/hooks/contacts";

export const Route = createFileRoute("/_chat/")({
  component: RouteComponent,
  validateSearch: z.object({ id: z.string().optional() }),
});

function RouteComponent() {
  const { id } = Route.useSearch();
  const listContactQuery = useListContacts();
  const reachable = useContactReachability();
  const overlayPeers = useOverlayPeers();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const hasContacts = (listContactQuery.data?.length ?? 0) > 0;
  const noneReachable = hasContacts && reachable.size === 0;

  return (
    <div className="h-full w-full">
      {noneReachable && overlayPeers === 0 && (
        <p className="shrink-0 border-b bg-muted/50 px-4 py-2 text-center text-xs text-muted-foreground">
          No connected libp2p peers yet. Open a mutual contact&apos;s chat to
          auto-connect once you are overlay peers.
        </p>
      )}

      {isDesktop ? (
        <ResizablePanelGroup orientation="horizontal" className="h-full w-full">
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
        <div className="h-full w-full">
          <ChatList />
        </div>
      )}
    </div>
  );
}
