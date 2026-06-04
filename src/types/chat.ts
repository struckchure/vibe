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
};

export type Conversation = {
  id: string;
  peerId: string;
  displayName: string;
  lastMessage?: string;
  lastMessageAt?: number;
  unreadCount?: number;
};
