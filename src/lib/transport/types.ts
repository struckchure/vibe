import type { Message } from "@/types/chat";

export type TextSignalingMessage = {
  type: "offer" | "answer" | "ice";
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

export type CallSignalingMessage =
  | {
      type: "call-invite";
      media: "audio" | "video";
      sdp: RTCSessionDescriptionInit;
      callLeg: number;
    }
  | { type: "call-answer"; sdp: RTCSessionDescriptionInit; callLeg: number }
  | { type: "call-decline"; callLeg: number }
  | { type: "call-end"; callLeg: number };

export type SignalingMessage = TextSignalingMessage | CallSignalingMessage;

export type SignalingEnvelope = SignalingMessage & { from?: string };

export function isCallSignal(
  msg: SignalingMessage
): msg is CallSignalingMessage {
  return (
    msg.type === "call-invite" ||
    msg.type === "call-answer" ||
    msg.type === "call-decline" ||
    msg.type === "call-end"
  );
}

export type SendTextResult = {
  via: "dc" | "queued";
  message: Message;
};
