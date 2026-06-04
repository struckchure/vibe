import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { Message } from "@/types/chat";

export type Contact = {
  peerId: string;
  displayName: string;
  conversationId: string;
  lastMessage: string | null;
  lastMessageAt: number | null;
  unreadCount: number;
};

export type RoomPeer = {
  peerId: string;
  displayName: string;
};

export type IdentityInfo = {
  peerId: string;
  publicKey: string;
};

export async function getIdentity(): Promise<IdentityInfo> {
  return invoke<IdentityInfo>("get_identity");
}

export async function revealPrivateKey(): Promise<string> {
  return invoke<string>("reveal_private_key");
}

export async function exportIdentityBackup(): Promise<string> {
  return invoke<string>("export_identity_backup");
}

export async function exportIdentityBackupFile(): Promise<void> {
  return invoke("export_identity_backup_file");
}

export async function importIdentityFromPaste(json: string): Promise<void> {
  return invoke("import_identity_backup", { json });
}

export async function importIdentityBackupFile(): Promise<void> {
  return invoke("import_identity_backup_file");
}

export async function regenerateIdentity(): Promise<void> {
  return invoke("regenerate_identity");
}

export async function getPeerId(): Promise<string> {
  return invoke<string>("get_peer_id");
}

export async function addContact(
  peerId: string,
  displayName: string
): Promise<Contact> {
  return invoke<Contact>("add_contact", { peerId, displayName });
}

export async function listContacts(): Promise<Contact[]> {
  return invoke<Contact[]>("list_contacts");
}

export async function removeContact(peerId: string): Promise<void> {
  return invoke("remove_contact", { peerId });
}

export type RoomStatus = {
  inRoom: boolean;
  code: string | null;
};

export async function roomStatus(): Promise<RoomStatus> {
  return invoke<RoomStatus>("room_status");
}

export async function joinRoom(
  code: string,
  displayName: string
): Promise<void> {
  return invoke("join_room", { code, displayName });
}

export async function subscribeConversation(
  conversationId: string
): Promise<void> {
  return invoke("subscribe_conversation", { conversationId });
}

export type RoomEvent = {
  kind: "join" | "leave";
  peerId: string;
  displayName: string;
  at: number;
};

export async function leaveRoom(): Promise<void> {
  return invoke("leave_room");
}

export async function listRoomPeers(): Promise<RoomPeer[]> {
  return invoke<RoomPeer[]>("list_room_peers");
}

export async function startNetwork(): Promise<void> {
  return invoke("start_network");
}

export async function overlayPeerCount(): Promise<number> {
  return invoke<number>("overlay_peer_count");
}

export function onOverlayPeersChanged(
  handler: (count: number) => void
): Promise<() => void> {
  return listen<number>("overlay-peers-changed", (e) => handler(e.payload));
}

export async function sendMessage(
  peerId: string,
  body: string
): Promise<Message> {
  return invoke<Message>("send_message", { peerId, body });
}

export async function flushOutbox(): Promise<number> {
  return invoke<number>("flush_outbox");
}

export async function markOutgoingSent(
  peerId: string,
  messageId: string
): Promise<void> {
  return invoke("mark_outgoing_sent", { peerId, messageId });
}

export async function listMessages(peerId: string): Promise<Message[]> {
  return invoke<Message[]>("list_messages", { peerId });
}

export async function markConversationRead(peerId: string): Promise<void> {
  return invoke("mark_conversation_read", { peerId });
}

export async function publishSignaling(
  conversationId: string,
  payload: string
): Promise<void> {
  return invoke("publish_signaling", { conversationId, payload });
}

export async function prepareWireMessage(
  peerId: string,
  body: string
): Promise<{ wireBase64: string; sentAt: number; messageId: string }> {
  return invoke("prepare_wire_message", { peerId, body });
}

export async function persistOutgoingMessage(
  peerId: string,
  body: string,
  sentAt: number,
  messageId: string
): Promise<Message> {
  return invoke<Message>("persist_outgoing_message", {
    peerId,
    body,
    sentAt,
    messageId,
  });
}

export async function encryptSignaling(
  peerId: string,
  payload: string
): Promise<string> {
  return invoke<string>("encrypt_signaling", { peerId, payload });
}

export async function decryptSignaling(
  peerId: string,
  payload: string
): Promise<string> {
  return invoke<string>("decrypt_signaling", { peerId, payload });
}

export async function ingestDcMessage(
  peerId: string,
  wireBase64: string
): Promise<void> {
  return invoke("ingest_dc_message", { peerId, wireBase64 });
}

export function onMessageReceived(
  handler: (msg: Message) => void
): Promise<() => void> {
  return listen<Message>("message-received", (e) => handler(e.payload));
}

export function onRoomPeer(handler: (peer: RoomPeer) => void): Promise<() => void> {
  return listen<RoomPeer>("room-peer", (e) => handler(e.payload));
}

export function onRoomEvent(
  handler: (event: RoomEvent) => void
): Promise<() => void> {
  return listen<RoomEvent>("room-event", (e) => handler(e.payload));
}

export type MessageAckPayload = {
  peerId: string;
  messageId: string;
  conversationId: string;
  deliveredAt: number;
};

export function onMessageAck(
  handler: (payload: MessageAckPayload) => void
): Promise<() => void> {
  return listen<MessageAckPayload>("message-ack", (e) => handler(e.payload));
}

export type MessageReadPayload = {
  peerId: string;
  messageId: string;
  conversationId: string;
  readAt: number;
};

export function onMessageRead(
  handler: (payload: MessageReadPayload) => void
): Promise<() => void> {
  return listen<MessageReadPayload>("message-read", (e) => handler(e.payload));
}

export type ConversationReadPayload = {
  peerId: string;
  readAt: number;
};

export function onConversationRead(
  handler: (payload: ConversationReadPayload) => void
): Promise<() => void> {
  return listen<ConversationReadPayload>("conversation-read", (e) =>
    handler(e.payload)
  );
}

export type MessageUpdatedPayload = {
  peerId: string;
  messageId: string;
  pending: boolean;
};

export function onMessageUpdated(
  handler: (payload: MessageUpdatedPayload) => void
): Promise<() => void> {
  return listen<MessageUpdatedPayload>("message-updated", (e) =>
    handler(e.payload)
  );
}

export function onOutboxFlushed(
  handler: (count: number) => void
): Promise<() => void> {
  return listen<number>("outbox-flushed", (e) => handler(e.payload));
}

export function onIdentityChanged(handler: () => void): Promise<() => void> {
  return listen("identity-changed", () => handler());
}

export function onSignaling(
  conversationId: string,
  handler: (payload: string) => void
): Promise<() => void> {
  return listen<{ conversationId: string; payload: string }>("signaling", (e) => {
    if (e.payload.conversationId === conversationId) {
      handler(e.payload.payload);
    }
  });
}
