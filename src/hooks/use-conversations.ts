import { useCallback, useEffect, useRef, useState } from "react";

import type { Conversation, Message } from "@/types/chat";
import * as api from "@/lib/tauri";
import { sendTextMessage } from "@/lib/webrtc";

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messagesByPeer, setMessagesByPeer] = useState<
    Record<string, Message[]>
  >({});
  const [loading, setLoading] = useState(true);
  const localPeerIdRef = useRef<string | null>(null);
  const openPeerIdRef = useRef<string | null>(null);

  const refreshContacts = useCallback(async () => {
    try {
      const contacts = await api.listContacts();
      setConversations(
        contacts.map((c) => ({
          id: c.conversationId,
          peerId: c.peerId,
          displayName: c.displayName,
          lastMessage: c.lastMessage ?? undefined,
          lastMessageAt: c.lastMessageAt ?? undefined,
          unreadCount: c.unreadCount ?? 0,
        }))
      );
    } catch {
      setConversations([]);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      localPeerIdRef.current = await api.getPeerId();
      await refreshContacts();
      await api.startNetwork();
      setLoading(false);
    })();
  }, [refreshContacts]);

  const markAsRead = useCallback(async (peerId: string) => {
    try {
      let hadUnread = false;
      setMessagesByPeer((prev) => {
        const list = prev[peerId];
        if (!list) return prev;
        let changed = false;
        const readAt = Date.now();
        const next = list.map((m) => {
          if (!m.outgoing && !m.readAt && m.kind !== "call") {
            changed = true;
            hadUnread = true;
            return { ...m, readAt };
          }
          return m;
        });
        if (!changed) return prev;
        return { ...prev, [peerId]: next };
      });
      setConversations((prev) => {
        const conv = prev.find((c) => c.peerId === peerId);
        if (!conv || (conv.unreadCount ?? 0) === 0) {
          return prev;
        }
        hadUnread = true;
        return prev.map((c) =>
          c.peerId === peerId ? { ...c, unreadCount: 0 } : c
        );
      });
      if (!hadUnread) return;

      await api.markConversationRead(peerId);
      void refreshContacts();
    } catch {
      /* ignore when offline */
    }
  }, [refreshContacts]);

  const setOpenPeerId = useCallback((peerId: string | null) => {
    openPeerIdRef.current = peerId;
  }, []);

  useEffect(() => {
    const unlistenMsg = api.onMessageReceived((msg) => {
      setMessagesByPeer((prev) => ({
        ...prev,
        [msg.peerId]: [...(prev[msg.peerId] ?? []), msg],
      }));
      setConversations((prev) =>
        prev.map((c) =>
          c.peerId === msg.peerId
            ? {
                ...c,
                lastMessage: msg.body,
                lastMessageAt: msg.sentAt,
                unreadCount:
                  openPeerIdRef.current === msg.peerId || msg.kind === "call"
                    ? 0
                    : (c.unreadCount ?? 0) + 1,
              }
            : c
        )
      );
      if (openPeerIdRef.current === msg.peerId) {
        if (msg.kind !== "call") {
          void markAsRead(msg.peerId);
        }
      } else {
        void refreshContacts();
      }
    });
    const unlistenAck = api.onMessageAck(
      ({ peerId, messageId, deliveredAt }) => {
        setMessagesByPeer((prev) => {
          const list = prev[peerId];
          if (!list) return prev;
          let changed = false;
          const next = list.map((m) => {
            if (m.id === messageId && m.deliveredAt !== deliveredAt) {
              changed = true;
              return { ...m, deliveredAt };
            }
            return m;
          });
          if (!changed) return prev;
          return { ...prev, [peerId]: next };
        });
      }
    );
    const unlistenRead = api.onMessageRead(
      ({ peerId, messageId, readAt }) => {
        setMessagesByPeer((prev) => {
          const list = prev[peerId];
          if (!list) return prev;
          let changed = false;
          const next = list.map((m) => {
            if (m.id === messageId && m.readAt !== readAt) {
              changed = true;
              return { ...m, readAt };
            }
            return m;
          });
          if (!changed) return prev;
          return { ...prev, [peerId]: next };
        });
      }
    );
    const unlistenUpdated = api.onMessageUpdated(
      ({ peerId, messageId, pending }) => {
        setMessagesByPeer((prev) => {
          const list = prev[peerId];
          if (!list) return prev;
          return {
            ...prev,
            [peerId]: list.map((m) =>
              m.id === messageId ? { ...m, pending } : m
            ),
          };
        });
      }
    );
    const unlistenConvRead = api.onConversationRead(({ peerId, readAt }) => {
      let changed = false;
      setMessagesByPeer((prev) => {
        const list = prev[peerId];
        if (!list) return prev;
        const next = list.map((m) => {
          if (!m.outgoing && !m.readAt && m.kind !== "call") {
            changed = true;
            return { ...m, readAt };
          }
          return m;
        });
        if (!changed) return prev;
        return { ...prev, [peerId]: next };
      });
      if (changed) {
        void refreshContacts();
      }
    });
    return () => {
      void unlistenMsg.then((fn) => fn());
      void unlistenAck.then((fn) => fn());
      void unlistenRead.then((fn) => fn());
      void unlistenUpdated.then((fn) => fn());
      void unlistenConvRead.then((fn) => fn());
    };
  }, [refreshContacts, markAsRead]);

  const addContact = useCallback(
    async (peerId: string, displayName: string) => {
      await api.addContact(peerId, displayName);
      await refreshContacts();
    },
    [refreshContacts]
  );

  const removeContact = useCallback(async (peerId: string) => {
    await api.removeContact(peerId);
    setMessagesByPeer((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
    await refreshContacts();
  }, [refreshContacts]);

  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const loadMessages = useCallback(async (peerId: string) => {
    const conv = conversationsRef.current.find((c) => c.peerId === peerId);
    if (conv) {
      await api.startNetwork();
      await api.subscribeConversation(conv.id);
    }
    const msgs = await api.listMessages(peerId);
    setMessagesByPeer((prev) => {
      const existing = prev[peerId];
      if (
        existing &&
        existing.length === msgs.length &&
        existing.every((m, i) => m.id === msgs[i]?.id)
      ) {
        return prev;
      }
      return { ...prev, [peerId]: msgs };
    });
    if (openPeerIdRef.current === peerId) {
      await markAsRead(peerId);
    }
  }, [markAsRead]);

  const sendMessage = useCallback(
    async (peerId: string, body: string) => {
      const localPeerId = localPeerIdRef.current ?? (await api.getPeerId());
      localPeerIdRef.current = localPeerId;

      const conv = conversations.find((c) => c.peerId === peerId);
      if (!conv) {
        throw new Error("contact not found");
      }

      await api.startNetwork();

      const { message } = await sendTextMessage(
        localPeerId,
        peerId,
        conv.id,
        body
      );

      setMessagesByPeer((prev) => ({
        ...prev,
        [peerId]: [...(prev[peerId] ?? []), message],
      }));
      await refreshContacts();
      return message;
    },
    [conversations, refreshContacts]
  );

  const getLocalPeerId = useCallback(async () => {
    if (!localPeerIdRef.current) {
      localPeerIdRef.current = await api.getPeerId();
    }
    return localPeerIdRef.current;
  }, []);

  return {
    conversations,
    messagesByPeer,
    loading,
    refreshContacts,
    addContact,
    removeContact,
    loadMessages,
    sendMessage,
    setOpenPeerId,
    markAsRead,
    getLocalPeerId,
  };
}
