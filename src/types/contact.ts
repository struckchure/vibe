import type { Conversation } from "@/types/chat";
import type { Contact } from "@/lib/tauri";

/** Minimal contact identity passed to chat/call hook actions. */
export type ContactRef = Pick<
  Contact,
  "peerId" | "conversationId" | "displayName"
>;

/** Map a contact or conversation row to {@link ContactRef}. */
export function toContactRef(
  contact: Contact | Conversation
): ContactRef {
  if ("conversationId" in contact) {
    return {
      peerId: contact.peerId,
      conversationId: contact.conversationId,
      displayName: contact.displayName,
    };
  }
  return {
    peerId: contact.peerId,
    conversationId: contact.id,
    displayName: contact.displayName,
  };
}
