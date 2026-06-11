const PEER_URI_PREFIX = "vibe://peer/";

export type PeerInvite = {
  peerId: string;
  dialAddrs: string[];
};

function parseDialAddrsFromQuery(query: string): string[] {
  const params = new URLSearchParams(
    query.startsWith("?") ? query.slice(1) : query,
  );
  const addrs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "a" && value) {
      addrs.push(decodeURIComponent(value));
    }
  }
  return addrs;
}

/** Parse peer invite URI or raw base64url peer ID. */
export function parsePeerInvite(input: string): PeerInvite | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.toLowerCase().startsWith(PEER_URI_PREFIX)) {
    const rest = trimmed.slice(PEER_URI_PREFIX.length);
    const qIndex = rest.indexOf("?");
    const pathPart = qIndex >= 0 ? rest.slice(0, qIndex) : rest;
    const queryPart = qIndex >= 0 ? rest.slice(qIndex + 1) : "";
    const peerId = pathPart.trim();
    if (!peerId) return null;
    return {
      peerId,
      dialAddrs: queryPart ? parseDialAddrsFromQuery(queryPart) : [],
    };
  }

  return { peerId: trimmed, dialAddrs: [] };
}

/** Normalize raw base64url peer ID or `vibe://peer/...` URI. */
export function parsePeerId(input: string): string | null {
  return parsePeerInvite(input)?.peerId ?? null;
}

export function peerInviteUri(
  publicKey: string,
  dialAddrs?: string[],
): string {
  const base = `${PEER_URI_PREFIX}${publicKey}`;
  if (!dialAddrs?.length) return base;
  return `${base}?a=${encodeURIComponent(dialAddrs[0])}`;
}

/** Parse `vibe://peer/…` invite URLs only (not raw peer IDs). */
export function parsePeerInviteUrl(input: string): PeerInvite | null {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith(PEER_URI_PREFIX)) return null;
  return parsePeerInvite(trimmed);
}
