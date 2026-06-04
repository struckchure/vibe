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
  const messagesByPeerRef = useRef(messagesByPeer);
  messagesByPeerRef.current = messagesByPeer;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  function mergeMessage(existing: Message | undefined, incoming: Message): Message {
    if (!existing) return incoming;
    return {
      ...incoming,
      readAt: existing.readAt ?? incoming.readAt ?? null,
      deliveredAt: existing.deliveredAt ?? incoming.deliveredAt ?? null,
      pending: incoming.pending && existing.pending,
    };
  }

  function upsertMessage(list: Message[], incoming: Message): Message[] {
    const idx = list.findIndex((m) => m.id === incoming.id);
    if (idx < 0) return [...list, incoming];
    const merged = mergeMessage(list[idx], incoming);
    if (
      list[idx]!.readAt === merged.readAt &&
      list[idx]!.deliveredAt === merged.deliveredAt &&
      list[idx]!.pending === merged.pending &&
      list[idx]!.body === merged.body
    ) {
      return list;
    }
    const next = [...list];
    next[idx] = merged;
    return next;
  }

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
      const conv = conversationsRef.current.find((c) => c.peerId === peerId);
      const list = messagesByPeerRef.current[peerId] ?? [];
      const needsMark =
        (conv?.unreadCount ?? 0) > 0 ||
        list.some((m) => !m.outgoing && !m.readAt && m.kind !== "call");
      if (!needsMark) return;

      const readAt = Date.now();
      setMessagesByPeer((prev) => {
        const msgs = prev[peerId];
        if (!msgs) return prev;
        let changed = false;
        const next = msgs.map((m) => {
          if (!m.outgoing && !m.readAt && m.kind !== "call") {
            changed = true;
            return { ...m, readAt };
          }
          return m;
        });
        if (!changed) return prev;
        return { ...prev, [peerId]: next };
      });
      setConversations((prev) =>
        prev.map((c) =>
          c.peerId === peerId ? { ...c, unreadCount: 0 } : c
        )
      );

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
      let isNew = false;
      setMessagesByPeer((prev) => {
        const list = prev[msg.peerId] ?? [];
        isNew = !list.some((m) => m.id === msg.id);
        const next = upsertMessage(list, msg);
        if (next === list) return prev;
        return { ...prev, [msg.peerId]: next };
      });
      setConversations((prev) =>
        prev.map((c) => {
          if (c.peerId !== msg.peerId) return c;
          const threadOpen = openPeerIdRef.current === msg.peerId;
          let unreadCount = c.unreadCount ?? 0;
          if (threadOpen) {
            unreadCount = 0;
          } else if (isNew && msg.kind !== "call") {
            unreadCount += 1;
          }
          return {
            ...c,
            lastMessage: msg.body,
            lastMessageAt: msg.sentAt,
            unreadCount,
          };
        })
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

  const loadMessages = useCallback(async (peerId: string) => {
    const conv = conversationsRef.current.find((c) => c.peerId === peerId);
    if (conv) {
      await api.startNetwork();
      await api.subscribeConversation(conv.id);
    }
    const msgs = await api.listMessages(peerId);
    setMessagesByPeer((prev) => {
      const existing = prev[peerId];
      if (!existing?.length) {
        return { ...prev, [peerId]: msgs };
      }
      const localById = new Map(existing.map((m) => [m.id, m]));
      let changed = existing.length !== msgs.length;
      const merged = msgs.map((server) => {
        const local = localById.get(server.id);
        const next = mergeMessage(local, server);
        if (
          local &&
          local.readAt === next.readAt &&
          local.deliveredAt === next.deliveredAt &&
          local.body === next.body
        ) {
          return local;
        }
        changed = true;
        return next;
      });
      if (!changed) return prev;
      return { ...prev, [peerId]: merged };
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
