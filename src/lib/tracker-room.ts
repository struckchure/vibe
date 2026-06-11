const INFO_HASH_BYTES = 20;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64UrlToBytes(encoded: string): Uint8Array {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function digest20(input: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", input.buffer as ArrayBuffer);
  return bytesToHex(new Uint8Array(hash).slice(0, INFO_HASH_BYTES));
}

/** 20-byte BitTorrent infoHash (40 hex) for a conversation room. */
export async function infoHashFromConversationId(
  conversationId: string,
): Promise<string> {
  return digest20(new TextEncoder().encode(conversationId));
}

/** Stable 20-byte tracker peer id derived from Vibe Ed25519 public key. */
export async function trackerPeerIdFromVibePeerId(
  peerIdB64: string,
): Promise<string> {
  return digest20(base64UrlToBytes(peerIdB64));
}
