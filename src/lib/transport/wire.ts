import type { Message } from "@/types/chat";
import * as api from "@/lib/tauri";

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function wireBytesFromData(
  data: string | ArrayBuffer | ArrayBufferView
): Uint8Array {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export async function sendViaGossipsub(
  peerId: string,
  body: string
): Promise<Message> {
  return api.sendMessage(peerId, body);
}

export async function sendViaDataChannel(
  peerId: string,
  body: string,
  channel: RTCDataChannel
): Promise<Message> {
  const { wireBase64, messageId } = await api.prepareWireMessage(peerId, body);
  const wireBytes = Uint8Array.from(atob(wireBase64), (c) => c.charCodeAt(0));
  if (channel.readyState !== "open") {
    throw new Error("data channel not open");
  }
  channel.send(wireBytes);
  await api.markOutgoingSent(peerId, messageId);
  const messages = await api.listMessages(peerId);
  const message = messages.find((m) => m.id === messageId);
  if (!message) {
    throw new Error("message not found after send");
  }
  return message;
}

export function ingestDataChannelMessage(
  peerId: string,
  data: string | ArrayBuffer | ArrayBufferView
) {
  const wireBytes = wireBytesFromData(data);
  const wireBase64 = bytesToBase64(wireBytes);
  void api.ingestDcMessage(peerId, wireBase64);
}
