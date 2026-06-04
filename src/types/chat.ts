export type MessageKind = "text" | "call";

export type CallOutcome = "completed" | "missed" | "declined" | "cancelled";

export type Message = {
  id: string;
  conversationId: string;
  peerId: string;
  body: string;
  sentAt: number;
  outgoing: boolean;
  deliveredAt?: number | null;
  readAt?: number | null;
  pending?: boolean;
  kind?: MessageKind;
  callMedia?: "audio" | "video";
  callOutcome?: CallOutcome;
  callDurationMs?: number | null;
};

export type Conversation = {
  id: string;
  peerId: string;
  displayName: string;
  lastMessage?: string;
  lastMessageAt?: number;
  unreadCount?: number;
};
