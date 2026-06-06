import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useListContacts, useLocalPeerId } from "@/hooks/contacts";
import type { ContactRef } from "@/types/contact";
import * as api from "@/lib/tauri";
import {
  ensureTextTransport,
  isTextChannelOpen,
  subscribeTextChannelState,
} from "@/lib/webrtc";

import {
  contactRefFromPeerId,
  getMessagesSnapshot,
  subscribeMessages,
  updatePeerMessages,
  upsertMessage,
} from "./messages-store";
import type { UseTextChatIsChannelOpenProps, UseTextChatProps } from "./types";

let listenerSubscribers = 0;
let stopListeners: (() => void) | null = null;
const contactsRef: { current: ContactRef[] } = { current: [] };

/**
 * App-wide text chat runtime — message store, transport sync, and event listeners.
 * Use {@link useTextChatSend}, {@link useTextChatLoad}, and {@link useTextChatMarkAsRead} for actions.
 */
export function useTextChat(props?: UseTextChatProps) {
  const listContactQuery = useListContacts();
  const localPeerIdQuery = useLocalPeerId();
  const messagesByPeer = useSyncExternalStore(
    subscribeMessages,
    getMessagesSnapshot,
    getMessagesSnapshot
  );
  const [, bumpChannel] = useState(0);
  const onIncomingRef = useRef(props?.onIncoming);
  onIncomingRef.current = props?.onIncoming;

  useEffect(() => {
    const unsubscribe = subscribeTextChannelState(() => {
      bumpChannel((n) => n + 1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    async function syncTransport() {
      const localPeerId = localPeerIdQuery.data;
      if (!localPeerId) {
        return;
      }
      await api.startNetwork();
      for (const contact of listContactQuery.data ?? []) {
        await ensureTextTransport(
          localPeerId,
          contact.peerId,
          contact.conversationId
        );
      }
    }
    syncTransport();
  }, [listContactQuery.data, localPeerIdQuery.data]);

  useEffect(() => {
    contactsRef.current = (listContactQuery.data ?? []).map((c) => ({
      peerId: c.peerId,
      conversationId: c.conversationId,
      displayName: c.displayName,
    }));
  }, [listContactQuery.data]);

  useEffect(() => {
    listenerSubscribers += 1;
    if (listenerSubscribers === 1) {
      const unlistenMsg = api.onMessageReceived((msg) => {
        updatePeerMessages(msg.peerId, (list) => upsertMessage(list, msg));
        const contact = contactRefFromPeerId(msg.peerId, contactsRef.current);
        if (contact) {
          onIncomingRef.current?.(contact, msg);
        }
      });
      const unlistenAck = api.onMessageAck(
        ({ peerId, messageId, deliveredAt }) => {
          updatePeerMessages(peerId, (list) => {
            let changed = false;
            const next = list.map((m) => {
              if (m.id === messageId && m.deliveredAt !== deliveredAt) {
                changed = true;
                return { ...m, deliveredAt };
              }
              return m;
            });
            return changed ? next : list;
          });
        }
      );
      const unlistenRead = api.onMessageRead(({ peerId, messageId, readAt }) => {
        updatePeerMessages(peerId, (list) => {
          let changed = false;
          const next = list.map((m) => {
            if (m.id === messageId && m.readAt !== readAt) {
              changed = true;
              return { ...m, readAt };
            }
            return m;
          });
          return changed ? next : list;
        });
      });
      const unlistenUpdated = api.onMessageUpdated(
        ({ peerId, messageId, pending }) => {
          updatePeerMessages(peerId, (list) =>
            list.map((m) => (m.id === messageId ? { ...m, pending } : m))
          );
        }
      );
      const unlistenConvRead = api.onConversationRead(({ peerId, readAt }) => {
        updatePeerMessages(peerId, (list) => {
          let changed = false;
          const next = list.map((m) => {
            if (!m.outgoing && !m.readAt && m.kind !== "call") {
              changed = true;
              return { ...m, readAt };
            }
            return m;
          });
          return changed ? next : list;
        });
      });

      stopListeners = () => {
        unlistenMsg.then((fn) => fn());
        unlistenAck.then((fn) => fn());
        unlistenRead.then((fn) => fn());
        unlistenUpdated.then((fn) => fn());
        unlistenConvRead.then((fn) => fn());
      };
    }

    return () => {
      listenerSubscribers -= 1;
      if (listenerSubscribers === 0 && stopListeners) {
        stopListeners();
        stopListeners = null;
      }
    };
  }, []);

  const isChannelOpen = useCallback(
    ({ contact }: UseTextChatIsChannelOpenProps) =>
      isTextChannelOpen(contact.peerId),
    []
  );

  return {
    messagesByPeer,
    isChannelOpen,
  };
}
