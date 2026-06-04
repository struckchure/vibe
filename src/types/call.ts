export type CallMedia = "audio" | "video";

export type CallPhase =
  | "idle"
  | "outgoing"
  | "incoming"
  | "connecting"
  | "active"
  | "ended";

export type CallDirection = "outgoing" | "incoming";

export type ActiveCall = {
  peerId: string;
  displayName: string;
  conversationId: string;
  media: CallMedia;
  direction: CallDirection;
  phase: CallPhase;
  startedAt: number | null;
  connectedAt: number | null;
  /** True after call-invite was sent or received over signaling. */
  signaled: boolean;
};
