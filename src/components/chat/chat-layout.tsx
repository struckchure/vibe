import { useCallback, useEffect, useMemo, useState } from "react";

import { ChatEmpty } from "@/components/chat/chat-empty";
import { ChatList } from "@/components/chat/chat-list";
import { ChatThread } from "@/components/chat/chat-thread";
import { DiscoveryDialogs } from "@/components/chat/discovery-dialogs";
import { IdentityDialog } from "@/components/chat/identity-dialog";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useConversations } from "@/hooks/use-conversations";
import { useMediaQuery } from "@/hooks/use-media-query";
import * as api from "@/lib/tauri";
import { closeTextTransport, ensureTextTransport, isTextChannelOpen } from "@/lib/webrtc";

export function ChatLayout() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [joinRoomOpen, setJoinRoomOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [dcOpen, setDcOpen] = useState(false);
  const [overlayPeers, setOverlayPeers] = useState(0);

  const {
    conversations,
    messagesByPeer,
    refreshContacts,
    loadMessages,
    sendMessage,
    removeContact,
    setOpenPeerId,
    markAsRead,
    getLocalPeerId,
  } = useConversations();

  useEffect(() => {
    void (async () => {
      await api.startNetwork();
      setOverlayPeers(await api.overlayPeerCount());
    })();
    const unlisten = api.onOverlayPeersChanged((count) => {
      setOverlayPeers(count);
      if (count > 0) {
        void api.flushOutbox();
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = api.onIdentityChanged(() => {
      setSelectedId(null);
      void refreshContacts();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshContacts]);

  useEffect(() => {
    void (async () => {
      const localPeerId = await getLocalPeerId();
      await api.startNetwork();
      for (const conv of conversations) {
        void ensureTextTransport(localPeerId, conv.peerId, conv.id);
      }
    })();
  }, [conversations, getLocalPeerId]);

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  useEffect(() => {
    if (!selected) {
      setDcOpen(false);
      return;
    }
    const tick = () => setDcOpen(isTextChannelOpen(selected.peerId));
    tick();
    const interval = setInterval(tick, 1500);
    return () => clearInterval(interval);
  }, [selected]);

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      const conv = conversations.find((c) => c.id === id);
      if (conv) {
        setOpenPeerId(conv.peerId);
        void (async () => {
          const localPeerId = await getLocalPeerId();
          await api.startNetwork();
          await ensureTextTransport(localPeerId, conv.peerId, conv.id);
          setDcOpen(isTextChannelOpen(conv.peerId));
          await loadMessages(conv.peerId);
        })();
      }
    },
    [conversations, loadMessages, getLocalPeerId, setOpenPeerId],
  );

  useEffect(() => {
    if (!selected) {
      setOpenPeerId(null);
      return;
    }
    setOpenPeerId(selected.peerId);
  }, [selected, setOpenPeerId]);

  useEffect(() => {
    if (!selected) return;
    const peerId = selected.peerId;
    void markAsRead(peerId);
  }, [selected, selected?.peerId, messagesByPeer, markAsRead]);

  const handleSend = useCallback(
    async (body: string) => {
      if (!selected) return;
      await sendMessage(selected.peerId, body);
      setDcOpen(isTextChannelOpen(selected.peerId));
    },
    [selected, sendMessage],
  );

  const handleRemoveContact = useCallback(async () => {
    if (!selected) return;
    const peerId = selected.peerId;
    closeTextTransport(peerId);
    setOpenPeerId(null);
    await removeContact(peerId);
    setSelectedId(null);
  }, [selected, removeContact, setOpenPeerId]);

  const isDesktop = useMediaQuery("(min-width: 768px)");

  const chatList = (
    <ChatList
      conversations={conversations}
      selectedId={selectedId}
      onSelect={handleSelect}
      onAddContact={() => setAddContactOpen(true)}
      onJoinRoom={() => setJoinRoomOpen(true)}
      onIdentity={() => setIdentityOpen(true)}
    />
  );

  const threadProps = selected
    ? {
        conversation: selected,
        messages: messagesByPeer[selected.peerId] ?? [],
        onSend: handleSend,
        onLoadMessages: () => loadMessages(selected.peerId),
        onRemoveContact: handleRemoveContact,
        transport:
          dcOpen && overlayPeers > 0
            ? ("direct" as const)
            : ("relay" as const),
      }
    : null;

  return (
    <>
      <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
        {overlayPeers === 0 ? (
          <p className="shrink-0 border-b bg-muted/50 px-4 py-2 text-center text-xs text-muted-foreground">
            Offline — you can still send messages; they will deliver when you
            reconnect (join the same room on both devices to discover each other).
          </p>
        ) : null}
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
              {chatList}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel id="chat-thread" minSize="70%">
              {threadProps ? (
                <ChatThread {...threadProps} />
              ) : (
                <ChatEmpty />
              )}
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : threadProps ? (
          <ChatThread
            {...threadProps}
            onBack={() => {
              setOpenPeerId(null);
              setSelectedId(null);
            }}
          />
        ) : (
          <div className="h-full min-h-0 w-full min-w-0">{chatList}</div>
        )}
      </div>

      <IdentityDialog
        open={identityOpen}
        onOpenChange={setIdentityOpen}
        onIdentityChanged={() => {
          setSelectedId(null);
          void refreshContacts();
        }}
      />

      <DiscoveryDialogs
        addContactOpen={addContactOpen}
        onAddContactOpenChange={setAddContactOpen}
        joinRoomOpen={joinRoomOpen}
        onJoinRoomOpenChange={setJoinRoomOpen}
        onContactAdded={() => void refreshContacts()}
      />
    </>
  );
}
