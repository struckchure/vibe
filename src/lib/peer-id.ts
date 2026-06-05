const PEER_URI_PREFIX = "vibe://peer/";

/** Normalize raw base64url peer ID or `vibe://peer/...` URI. */
export function parsePeerId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.toLowerCase().startsWith(PEER_URI_PREFIX)) {
    const id = trimmed.slice(PEER_URI_PREFIX.length).trim();
    return id || null;
  }

  return trimmed;
}

export function peerInviteUri(publicKey: string): string {
  return `${PEER_URI_PREFIX}${publicKey}`;
}

/** Parse `vibe://peer/…` invite URLs only (not raw peer IDs). */
export function parsePeerInviteUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith(PEER_URI_PREFIX)) return null;
  const id = trimmed.slice(PEER_URI_PREFIX.length).trim();
  return id || null;
}
