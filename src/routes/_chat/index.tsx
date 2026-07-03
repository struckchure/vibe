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

export const Route = createFileRoute("/_chat/")({
  component: RouteComponent,
  validateSearch: z.object({ id: z.string().optional() }),
});

function RouteComponent() {
  const { id } = Route.useSearch();
  const isDesktop = useMediaQuery("(min-width: 768px)");

  return (
    <div className="h-full w-full">
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
