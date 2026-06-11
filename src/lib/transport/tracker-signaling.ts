import { resolveIceServers } from "@/lib/ice-config";
import { infoHashFromConversationId, trackerPeerIdFromVibePeerId } from "@/lib/tracker-room";
import { resolveTrackerUrls } from "@/lib/tracker-config";

import type { TrackerPeer as BtTrackerPeer } from "bittorrent-tracker";

type TrackerClientInstance = {
  start(): void;
  stop(): void;
  destroy(): void;
  on(event: "peer", listener: (peer: BtTrackerPeer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "warning", listener: (err: Error) => void): void;
};

type TrackerClientCtor = new (opts: {
  infoHash: string;
  peerId: string;
  announce: string[];
  rtcConfig: RTCConfiguration;
}) => TrackerClientInstance;

type TrackerWireHandler = (
  remotePeerId: string,
  conversationId: string,
  wire: string,
) => void;

let wireHandler: TrackerWireHandler | null = null;
let trackerClientCtor: TrackerClientCtor | null = null;

export function setTrackerWireHandler(handler: TrackerWireHandler) {
  wireHandler = handler;
}

type TrackerSession = {
  conversationId: string;
  remotePeerId: string;
  client: TrackerClientInstance;
  peers: BtTrackerPeer[];
  ready: boolean;
};

const sessions = new Map<string, TrackerSession>();
const listeners = new Set<() => void>();

async function loadTrackerClient(): Promise<TrackerClientCtor> {
  if (!trackerClientCtor) {
    const mod = await import("bittorrent-tracker");
    trackerClientCtor = mod.default as TrackerClientCtor;
  }
  return trackerClientCtor;
}

function notify() {
  for (const fn of listeners) {
    fn();
  }
}

function sessionKey(conversationId: string): string {
  return conversationId;
}

function setReady(session: TrackerSession, ready: boolean) {
  if (session.ready === ready) {
    return;
  }
  session.ready = ready;
  notify();
}

export function isTrackerSignalingReady(conversationId: string): boolean {
  return sessions.get(sessionKey(conversationId))?.ready ?? false;
}

export function subscribeTrackerSignalingState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function wirePayloadFromData(data: string | Uint8Array | ArrayBuffer): string {
  if (typeof data === "string") {
    return data;
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new TextDecoder().decode(bytes);
}

function attachTrackerPeer(
  session: TrackerSession,
  peer: BtTrackerPeer,
) {
  peer.on("connect", () => {
    if (!session.peers.includes(peer)) {
      session.peers.push(peer);
    }
    setReady(session, true);

    peer.on("data", (data) => {
      const wire = wirePayloadFromData(data);
      wireHandler?.(session.remotePeerId, session.conversationId, wire);
    });
  });

  peer.on("close", () => {
    session.peers = session.peers.filter((p) => p !== peer);
    if (session.peers.length === 0) {
      setReady(session, false);
    }
  });

  peer.on("error", () => {
    session.peers = session.peers.filter((p) => p !== peer);
    if (session.peers.length === 0) {
      setReady(session, false);
    }
  });
}

export async function ensureTrackerSignaling(
  conversationId: string,
  localPeerId: string,
  remotePeerId: string,
): Promise<void> {
  const key = sessionKey(conversationId);
  if (sessions.has(key)) {
    return;
  }

  let Client: TrackerClientCtor;
  try {
    Client = await loadTrackerClient();
  } catch (err) {
    console.warn("failed to load bittorrent-tracker:", err);
    return;
  }

  const [infoHash, trackerPeerId, iceServers] = await Promise.all([
    infoHashFromConversationId(conversationId),
    trackerPeerIdFromVibePeerId(localPeerId),
    resolveIceServers(),
  ]);

  const client = new Client({
    infoHash,
    peerId: trackerPeerId,
    announce: resolveTrackerUrls(),
    rtcConfig: { iceServers },
  });

  const session: TrackerSession = {
    conversationId,
    remotePeerId,
    peers: [],
    ready: false,
    client,
  };

  client.on("peer", (peer: BtTrackerPeer) => {
    attachTrackerPeer(session, peer);
  });

  client.on("error", (err: Error) => {
    console.warn("tracker client error:", err.message);
  });

  client.on("warning", (err: Error) => {
    console.warn("tracker warning:", err.message);
  });

  sessions.set(key, session);
  client.start();
}

export async function publishOnTrackerTunnel(
  conversationId: string,
  encrypted: string,
  waitForDelivery: boolean,
): Promise<void> {
  const session = sessions.get(sessionKey(conversationId));
  if (!session?.ready || session.peers.length === 0) {
    throw new Error("tracker signaling tunnel not ready");
  }

  const wire = JSON.stringify({ payload: encrypted });
  for (const peer of session.peers) {
    peer.send(wire);
  }

  if (!waitForDelivery) {
    return;
  }

  await new Promise((r) => setTimeout(r, 50));
}

export function teardownTrackerSignaling(conversationId: string): void {
  const key = sessionKey(conversationId);
  const session = sessions.get(key);
  if (!session) {
    return;
  }

  try {
    session.client.stop();
    session.client.destroy();
  } catch {
    /* ignore */
  }

  for (const peer of session.peers) {
    try {
      peer.destroy();
    } catch {
      /* ignore */
    }
  }

  sessions.delete(key);
  notify();
}
