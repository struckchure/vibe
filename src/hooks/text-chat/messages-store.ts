import type { ContactRef } from "@/types/contact";
import type { Message } from "@/types/chat";

export let messagesByPeer: Record<string, Message[]> = {};
const messageListeners = new Set<() => void>();

export function mergeMessage(
  existing: Message | undefined,
  incoming: Message
): Message {
  if (!existing) {
    return incoming;
  }
  return {
    ...incoming,
    readAt: existing.readAt ?? incoming.readAt ?? null,
    deliveredAt: existing.deliveredAt ?? incoming.deliveredAt ?? null,
    pending: incoming.pending && existing.pending,
  };
}

export function upsertMessage(list: Message[], incoming: Message): Message[] {
  const idx = list.findIndex((m) => m.id === incoming.id);
  if (idx < 0) {
    return [...list, incoming];
  }
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

function setMessagesByPeer(next: Record<string, Message[]>) {
  messagesByPeer = next;
  for (const fn of messageListeners) {
    fn();
  }
}

export function updatePeerMessages(
  peerId: string,
  updater: (list: Message[]) => Message[]
) {
  const list = messagesByPeer[peerId] ?? [];
  const next = updater(list);
  if (next === list) {
    return;
  }
  setMessagesByPeer({ ...messagesByPeer, [peerId]: next });
}

export function subscribeMessages(listener: () => void) {
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
}

export function getMessagesSnapshot() {
  return messagesByPeer;
}

export function contactRefFromPeerId(
  peerId: string,
  contacts: ContactRef[]
): ContactRef | null {
  return contacts.find((c) => c.peerId === peerId) ?? null;
}
