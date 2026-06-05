import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { useCallContext } from "@/contexts/call-context";
import { useConversationsContext } from "@/contexts/conversations-context";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useOverlayPeers } from "@/hooks/use-overlay-peers";
import { useTextChannelOpen } from "@/hooks/use-text-channel";
import * as api from "@/lib/tauri";
import { closeTextTransport, ensureTextTransport } from "@/lib/webrtc";

export function ChatLayout() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [joinRoomOpen, setJoinRoomOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const overlayPeers = useOverlayPeers();

  const {
    conversations,
    messagesByPeer,
    refreshContacts,
    loadMessages,
    sendMessage,
    removeContact,
    setOpenPeerId,
    getLocalPeerId,
  } = useConversationsContext();

  const { isBusy: callBusy, startVoiceCall, startVideoCall, endCall: endActiveCall } =
    useCallContext();

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

  const contactPeerIds = useMemo(
    () => new Set(conversations.map((c) => c.peerId)),
    [conversations],
  );

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const selectedPeerId = useMemo(
    () => conversations.find((c) => c.id === selectedId)?.peerId ?? null,
    [conversations, selectedId]
  );

  const textChannelOpen = useTextChannelOpen(selectedPeerId);

  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      const conv = conversationsRef.current.find((c) => c.id === id);
      if (conv) {
        setOpenPeerId(conv.peerId);
        void (async () => {
          const localPeerId = await getLocalPeerId();
          await api.startNetwork();
          await ensureTextTransport(localPeerId, conv.peerId, conv.id);
          await loadMessages(conv.peerId);
        })();
      }
    },
    [loadMessages, getLocalPeerId, setOpenPeerId],
  );

  const handleSend = useCallback(
    async (body: string) => {
      if (!selected) return;
      await sendMessage(selected.peerId, body);
    },
    [selected, sendMessage],
  );

  const handleRemoveContact = useCallback(async () => {
    if (!selected) return;
    const peerId = selected.peerId;
    if (callBusy) {
      await endActiveCall();
    }
    closeTextTransport(peerId);
    setOpenPeerId(null);
    await removeContact(peerId);
    setSelectedId(null);
  }, [selected, removeContact, setOpenPeerId, callBusy, endActiveCall]);

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
        onRemoveContact: handleRemoveContact,
        onVoiceCall: () => void startVoiceCall(selected),
        onVideoCall: () => void startVideoCall(selected),
        callBusy,
        transport:
          textChannelOpen && overlayPeers > 0
            ? ("direct" as const)
            : ("network" as const),
      }
    : null;

  return (
    <>
      <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
        {overlayPeers === 0 ? (
          <p className="shrink-0 border-b bg-muted/50 px-4 py-2 text-center text-xs text-muted-foreground">
            Offline — you can still send messages; they will deliver when you
            reconnect. Join a room or add a contact via QR to get on the
            network.
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
                <ChatThread key={threadProps.conversation.id} {...threadProps} />
              ) : (
                <ChatEmpty />
              )}
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : threadProps ? (
          <ChatThread
            key={threadProps.conversation.id}
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
        contactPeerIds={contactPeerIds}
      />
    </>
  );
}
