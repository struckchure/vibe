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

export type IdentityInfo = {
  peerId: string;
  publicKey: string;
};

export async function getIdentity(): Promise<IdentityInfo> {
  return await invoke<IdentityInfo>("get_identity");
}

export async function revealPrivateKey(): Promise<string> {
  return await invoke<string>("reveal_private_key");
}

export async function exportIdentityBackup(): Promise<string> {
  return await invoke<string>("export_identity_backup");
}

export async function exportIdentityBackupFile(): Promise<void> {
  return await invoke("export_identity_backup_file");
}

export async function importIdentityFromPaste(json: string): Promise<void> {
  return await invoke("import_identity_backup", { json });
}

export async function importIdentityBackupFile(): Promise<void> {
  return await invoke("import_identity_backup_file");
}

export async function regenerateIdentity(): Promise<void> {
  return await invoke("regenerate_identity");
}

export async function getPeerId(): Promise<string> {
  return await invoke<string>("get_peer_id");
}

export async function startNetwork(): Promise<void> {
  return await invoke("start_network");
}

export async function subscribeConversation(
  conversationId: string,
): Promise<void> {
  return await invoke("subscribe_conversation", { conversationId });
}

export async function overlayPeerCount(): Promise<number> {
  return await invoke<number>("overlay_peer_count");
}

export async function isOverlayPeerConnected(peerId: string): Promise<boolean> {
  return await invoke<boolean>("is_overlay_peer_connected", { peerId });
}

export async function dialContact(addrs: string[]): Promise<void> {
  return await invoke("dial_contact", { addrs });
}

export function onOverlayPeersChanged(
  handler: (count: number) => void,
): Promise<() => void> {
  return listen<number>("overlay-peers-changed", (e) => handler(e.payload));
}

export async function publishSignaling(
  conversationId: string,
  payload: string,
  waitForDelivery = true,
): Promise<void> {
  return await invoke("publish_signaling", {
    conversationId,
    payload,
    waitForDelivery,
  });
}

export function onSignaling(
  conversationId: string,
  handler: (payload: string) => void,
): Promise<() => void> {
  return listen<{ conversationId: string; payload: string }>(
    "signaling",
    (e) => {
      if (e.payload.conversationId === conversationId) {
        handler(e.payload.payload);
      }
    },
  );
}

export async function addContact(
  peerId: string,
  displayName: string,
): Promise<Contact> {
  return await invoke<Contact>("add_contact", { peerId, displayName });
}

export async function listContacts(): Promise<Contact[]> {
  return await invoke<Contact[]>("list_contacts");
}

export async function removeContact(peerId: string): Promise<void> {
  return await invoke("remove_contact", { peerId });
}

export async function isNoiseReady(peerId: string): Promise<boolean> {
  return await invoke<boolean>("is_noise_ready", { peerId });
}

export async function noiseHandshakeStart(
  peerId: string,
): Promise<{ messageB64: string }> {
  return await invoke("noise_handshake_start", { peerId });
}

export async function noiseHandshakeRespond(
  peerId: string,
  messageB64: string,
): Promise<{ messageB64: string }> {
  return await invoke("noise_handshake_respond", { peerId, messageB64 });
}

export async function noiseHandshakeFinishInitiator(
  peerId: string,
  messageB64: string,
): Promise<{ messageB64: string }> {
  return await invoke("noise_handshake_finish_initiator", {
    peerId,
    messageB64,
  });
}

export async function noiseHandshakeFinishResponder(
  peerId: string,
  messageB64: string,
): Promise<void> {
  return await invoke("noise_handshake_finish_responder", {
    peerId,
    messageB64,
  });
}

export async function prepareWireMessage(
  peerId: string,
  body: string,
): Promise<{ wireBase64: string; message: Message }> {
  return await invoke("prepare_wire_message", { peerId, body });
}

export async function persistOutgoingMessage(
  peerId: string,
  body: string,
  sentAt: number,
  messageId: string,
): Promise<Message> {
  return await invoke<Message>("persist_outgoing_message", {
    peerId,
    body,
    sentAt,
    messageId,
  });
}

export async function encryptSignaling(
  peerId: string,
  payload: string,
): Promise<string> {
  return await invoke<string>("encrypt_signaling", { peerId, payload });
}

export async function decryptSignaling(
  peerId: string,
  payload: string,
): Promise<string> {
  return await invoke<string>("decrypt_signaling", { peerId, payload });
}

export async function ingestDcMessage(
  peerId: string,
  wireBase64: string,
): Promise<void> {
  return await invoke("ingest_dc_message", { peerId, wireBase64 });
}

export async function markOutgoingSent(
  peerId: string,
  messageId: string,
): Promise<Message> {
  return await invoke<Message>("mark_outgoing_sent", { peerId, messageId });
}

export async function listMessages(peerId: string): Promise<Message[]> {
  return await invoke<Message[]>("list_messages", { peerId });
}

export async function listPendingOutgoing(): Promise<Message[]> {
  return await invoke<Message[]>("list_pending_outgoing");
}

export async function recordCallHistory(args: {
  peerId: string;
  conversationId: string;
  outgoing: boolean;
  media: "audio" | "video";
  outcome: "completed" | "missed" | "declined" | "cancelled";
  durationMs?: number | null;
}): Promise<Message> {
  return await invoke<Message>("record_call_history", {
    peerId: args.peerId,
    conversationId: args.conversationId,
    outgoing: args.outgoing,
    media: args.media,
    outcome: args.outcome,
    durationMs: args.durationMs ?? null,
  });
}

export async function markConversationRead(peerId: string): Promise<void> {
  return await invoke("mark_conversation_read", { peerId });
}

export function onMessageReceived(
  handler: (msg: Message) => void,
): Promise<() => void> {
  return listen<Message>("message-received", (e) => handler(e.payload));
}

export type MessageAckPayload = {
  peerId: string;
  messageId: string;
  conversationId: string;
  deliveredAt: number;
};

export function onMessageAck(
  handler: (payload: MessageAckPayload) => void,
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
  handler: (payload: MessageReadPayload) => void,
): Promise<() => void> {
  return listen<MessageReadPayload>("message-read", (e) => handler(e.payload));
}

export type ConversationReadPayload = {
  peerId: string;
  readAt: number;
};

export function onConversationRead(
  handler: (payload: ConversationReadPayload) => void,
): Promise<() => void> {
  return listen<ConversationReadPayload>("conversation-read", (e) =>
    handler(e.payload),
  );
}

export type MessageUpdatedPayload = {
  peerId: string;
  messageId: string;
  pending: boolean;
};

export function onMessageUpdated(
  handler: (payload: MessageUpdatedPayload) => void,
): Promise<() => void> {
  return listen<MessageUpdatedPayload>("message-updated", (e) =>
    handler(e.payload),
  );
}

export function onNoiseSessionReady(
  handler: (peerId: string) => void,
): Promise<() => void> {
  return listen<{ peerId: string }>("noise-session-ready", (e) =>
    handler(e.payload.peerId),
  );
}

export function onIdentityChanged(handler: () => void): Promise<() => void> {
  return listen("identity-changed", () => handler());
}
