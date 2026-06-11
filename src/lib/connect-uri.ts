/** Max URI length for QR rendering (SDP + ICE can exceed platform limits). */
export const CONNECT_URI_QR_MAX_LENGTH = 1800;

const CONNECT_PREFIX = "vibe://connect";

/** Real connect payloads compress to at least this many base64url chars. */
const MIN_PAYLOAD_PARAM_LENGTH = 80;

/** Strip copy/paste noise and recover a vibe://connect URI from partial input. */
export function normalizeConnectInput(raw: string): string {
  let s = raw.trim();
  if (!s) return s;

  const embedded = s.match(/vibe:\/\/connect\?p=[A-Za-z0-9_-]+/i);
  if (embedded) {
    return embedded[0]!;
  }

  const barePayload = s.match(/^(?:p=)?(H4sI[A-Za-z0-9_-]+)/);
  if (barePayload) {
    return `${CONNECT_PREFIX}?p=${barePayload[1]}`;
  }

  if (!s.toLowerCase().startsWith(CONNECT_PREFIX)) {
    return s;
  }

  const pIdx = s.indexOf("?p=");
  if (pIdx < 0) {
    return s.replace(/[;,\s]+$/g, "");
  }

  const prefix = s.slice(0, pIdx + 3);
  const payload = s
    .slice(pIdx + 3)
    .replace(/[^A-Za-z0-9_-].*$/, "");
  return prefix + payload;
}

function extractPayloadParam(input: string): string | null {
  const normalized = normalizeConnectInput(input);
  const match = normalized.match(/[?&]p=([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

export type ConnectPayload = {
  v: 1;
  from: string;
  to?: string;
  kind: "offer" | "answer";
  conversationId: string;
  sdp: RTCSessionDescriptionInit;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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

async function gzipEncode(text: string): Promise<Uint8Array> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gzipDecode(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

function isValidPayload(value: unknown): value is ConnectPayload {
  if (!value || typeof value !== "object") return false;
  const p = value as ConnectPayload;
  return (
    p.v === 1 &&
    typeof p.from === "string" &&
    (p.kind === "offer" || p.kind === "answer") &&
    typeof p.conversationId === "string" &&
    !!p.sdp?.type &&
    !!p.sdp?.sdp
  );
}

export function isConnectUri(input: string): boolean {
  const normalized = normalizeConnectInput(input);
  if (normalized.toLowerCase().startsWith(`${CONNECT_PREFIX}?`)) {
    return true;
  }
  try {
    const url = new URL(normalized);
    return url.protocol === "vibe:" && url.hostname === "connect";
  } catch {
    return /^H4sI[A-Za-z0-9_-]+$/.test(normalized);
  }
}

/** Stable dedup key for a connect URI (uses compressed payload param). */
export function connectUriFingerprint(input: string): string | null {
  const p = extractPayloadParam(input);
  return p ? `connect:${p}` : null;
}

export async function buildConnectUri(payload: ConnectPayload): Promise<string> {
  const compressed = await gzipEncode(JSON.stringify(payload));
  const p = bytesToBase64Url(compressed);
  return `${CONNECT_PREFIX}?p=${encodeURIComponent(p)}`;
}

export type ParseConnectUriResult =
  | { ok: true; payload: ConnectPayload }
  | { ok: false; error: string };

export async function parseConnectUriDetailed(
  input: string,
): Promise<ParseConnectUriResult> {
  const normalized = normalizeConnectInput(input);
  if (!isConnectUri(normalized)) {
    return {
      ok: false,
      error:
        "This doesn't look like a vibe://connect link. Make sure you copied the full link.",
    };
  }

  try {
    const p = extractPayloadParam(normalized);
    if (!p) {
      return {
        ok: false,
        error:
          "Connect link is missing session data. The link may be incomplete.",
      };
    }

    if (p.length < MIN_PAYLOAD_PARAM_LENGTH) {
      return {
        ok: false,
        error:
          "This link looks incomplete — it was cut off while copying. Use the Copy button on the other device (or select all of the link text) and paste again.",
      };
    }

    const json = await gzipDecode(base64UrlToBytes(decodeURIComponent(p)));
    const parsed: unknown = JSON.parse(json);
    if (!isValidPayload(parsed)) {
      return {
        ok: false,
        error:
          "Connect link contains invalid session data. Ask your contact to send a new link.",
      };
    }
    return { ok: true, payload: parsed };
  } catch {
    return {
      ok: false,
      error:
        "Could not read this connect link — it may be corrupted, truncated, or from an older version of Vibe.",
    };
  }
}

export async function parseConnectUri(
  input: string,
): Promise<ConnectPayload | null> {
  const result = await parseConnectUriDetailed(input);
  return result.ok ? result.payload : null;
}

export function connectUriFitsQr(uri: string): boolean {
  return uri.length <= CONNECT_URI_QR_MAX_LENGTH;
}
