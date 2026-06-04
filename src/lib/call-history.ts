import type { Message } from "@/types/chat";

export function isCallMessage(
  msg: Message
): msg is Message & { kind: "call" } {
  return msg.kind === "call";
}
