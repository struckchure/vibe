const CHAT_URI_PREFIX = "vibe://chat/";

/** Parse `vibe://chat/{conversationId}` deep links. */
export function parseChatDeepLink(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith(CHAT_URI_PREFIX)) {
    return null;
  }
  const conversationId = trimmed.slice(CHAT_URI_PREFIX.length).split("?")[0]?.trim();
  return conversationId || null;
}

export function isChatDeepLink(input: string): boolean {
  return parseChatDeepLink(input) !== null;
}
