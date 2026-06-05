import type { Message } from "@/types/chat";
import * as api from "@/lib/tauri";

export const TEXT_CHANNEL_LABEL = "vibe/text";

/** Dev/testing only — replace with user-configured TURN before production (SPEC §11.4). */
const OPEN_RELAY_TURN: RTCIceServer = {
  urls: [
    "turn:openrelay.metered.ca:80",
    "turn:openrelay.metered.ca:443",
    "turn:openrelay.metered.ca:443?transport=tcp",
  ],
  username: "openrelayproject",
  credential: "openrelayproject",
};

export const CALL_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  OPEN_RELAY_TURN,
];

export const ICE_SERVERS: RTCIceServer[] = [
  ...CALL_ICE_SERVERS,
  { urls: "stun:stun1.l.google.com:19302" },
];

export const CALL_ICE_GATHER_TIMEOUT_MS = 4000;

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

/** Outer gossip envelope (Rust SignalWire); legacy payloads pass through as ciphertext. */
type SignalWireOuter = {
  senderPeerId?: string;
  payload?: string;
};

function unwrapSignalingWire(raw: string): string | null {
  try {
    const outer = JSON.parse(raw) as SignalWireOuter;
    if (
      typeof outer.senderPeerId === "string" &&
      typeof outer.payload === "string"
    ) {
      if (
        signalingLocalPeerId &&
        outer.senderPeerId === signalingLocalPeerId
      ) {
        return null;
      }
      return outer.payload;
    }
  } catch {
    /* legacy: raw encrypted blob */
  }
  return raw;
}

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

export type PeerConnectionState = {
  pc: RTCPeerConnection;
  conversationId: string;
  remotePeerId: string;
  localPeerId: string;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  channel: RTCDataChannel | null;
  onRemoteTrack: ((stream: MediaStream) => void) | null;
  pendingIce: RTCIceCandidateInit[];
  /** Outbound ICE held until callLeg is ready (testclient pendingLocalIce). */
  pendingLocalIce: RTCIceCandidateInit[];
  callIceReady: boolean;
  /** Accumulated remote tracks for call PCs (iOS may omit ev.streams[0]). */
  remoteMediaStream: MediaStream | null;
};

export function sessionDescriptionPayload(
  desc: RTCSessionDescription | RTCSessionDescriptionInit | null | undefined
): RTCSessionDescriptionInit | null {
  if (!desc) return null;
  if (!desc.type || !desc.sdp) return null;
  return { type: desc.type, sdp: desc.sdp };
}

/** testclient sdpInit — accepts JSON-stringified SDP or raw SDP string. */
export function parseSessionDescription(
  sdp: RTCSessionDescriptionInit | string | null | undefined
): RTCSessionDescriptionInit | null {
  if (!sdp) return null;
  if (typeof sdp === "string") {
    try {
      const parsed = JSON.parse(sdp) as RTCSessionDescriptionInit;
      if (parsed?.type && parsed.sdp) {
        return { type: parsed.type, sdp: parsed.sdp };
      }
    } catch {
      return { type: "offer", sdp };
    }
    return null;
  }
  return sessionDescriptionPayload(sdp);
}

export async function applyRemoteDescription(
  pc: RTCPeerConnection,
  desc: RTCSessionDescriptionInit | string
) {
  const payload = parseSessionDescription(desc);
  if (!payload) {
    throw new Error("invalid session description");
  }
  await pc.setRemoteDescription(payload);
}

/** Wait until ICE gathering finishes so SDP includes connection candidates. */
export function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs = 8000
): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        done();
      }
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

async function addIceCandidateToPeer(
  state: PeerConnectionState,
  candidate: RTCIceCandidateInit
) {
  if (!state.pc.remoteDescription) {
    state.pendingIce.push(candidate);
    return;
  }
  try {
    await state.pc.addIceCandidate(candidate);
  } catch {
    /* ignore late ICE */
  }
}

function callIceQueueKey(conversationId: string, remotePeerId: string) {
  return `${conversationId}:${remotePeerId}`;
}

/** ICE received while ringing (no call PC) — testclient iceQueue equivalent. */
const orphanedCallIce = new Map<string, RTCIceCandidateInit[]>();

function queueOrphanedCallIce(
  conversationId: string,
  remotePeerId: string,
  candidate: RTCIceCandidateInit
) {
  const key = callIceQueueKey(conversationId, remotePeerId);
  const queue = orphanedCallIce.get(key) ?? [];
  queue.push(candidate);
  orphanedCallIce.set(key, queue);
}

export function clearOrphanedCallIce(
  conversationId: string,
  remotePeerId: string
) {
  orphanedCallIce.delete(callIceQueueKey(conversationId, remotePeerId));
}

export async function flushOrphanedCallIce(state: PeerConnectionState) {
  const key = callIceQueueKey(state.conversationId, state.remotePeerId);
  const queued = orphanedCallIce.get(key);
  if (!queued?.length || !state.pc.remoteDescription) {
    return;
  }
  orphanedCallIce.delete(key);
  for (const candidate of queued) {
    await addIceCandidateToPeer(state, candidate);
  }
}

export async function flushPendingIce(state: PeerConnectionState) {
  if (!state.pc.remoteDescription) {
    return;
  }
  await flushOrphanedCallIce(state);
  if (state.pendingIce.length === 0) {
    return;
  }
  const queued = state.pendingIce.splice(0);
  for (const candidate of queued) {
    try {
      await state.pc.addIceCandidate(candidate);
    } catch {
      /* ignore late ICE */
    }
  }
}

export function setCallIceReady(remotePeerId: string, ready: boolean) {
  const state = callPeers.get(remotePeerId);
  if (state) {
    state.callIceReady = ready;
  }
}

/** Publish outbound ICE queued before callLeg was ready (testclient flushPendingLocalIce). */
export async function flushPendingLocalIce(remotePeerId: string) {
  const state = callPeers.get(remotePeerId);
  if (!state || state.pendingLocalIce.length === 0) {
    return;
  }
  const queued = state.pendingLocalIce.splice(0);
  for (const candidate of queued) {
    publishSignalingBestEffort(state.conversationId, state.remotePeerId, {
      type: "ice",
      candidate,
    });
  }
}

const peers = new Map<string, PeerConnectionState>();
const callPeers = new Map<string, PeerConnectionState>();

let signalingLocalPeerId: string | null = null;

/** Set before publishing so gossipsub self-echo can be dropped in dispatch. */
export function setSignalingLocalPeerId(peerId: string) {
  signalingLocalPeerId = peerId;
}

let textTransportPaused = false;

/** Pause text data-channel negotiation while a voice/video call is active. */
export function setTextTransportPaused(paused: boolean) {
  textTransportPaused = paused;
}

const textChannelListeners = new Set<() => void>();

function notifyTextChannelListeners() {
  for (const fn of textChannelListeners) {
    fn();
  }
}

export function subscribeTextChannelState(listener: () => void) {
  textChannelListeners.add(listener);
  return () => textChannelListeners.delete(listener);
}

let callSignalingHandler:
  | ((
      remotePeerId: string,
      conversationId: string,
      msg: CallSignalingMessage
    ) => void | Promise<void>)
  | null = null;

/** One gossipsub listener per conversation — avoids handling each message twice. */
const signalingUnlistenByConversation = new Map<string, () => void>();

export function registerCallSignalingHandler(
  handler: (
    remotePeerId: string,
    conversationId: string,
    msg: CallSignalingMessage
  ) => void | Promise<void>
) {
  callSignalingHandler = handler;
}

export async function ensureConversationSignaling(
  conversationId: string,
  remotePeerId: string
) {
  if (signalingUnlistenByConversation.has(conversationId)) {
    return;
  }
  const unlisten = await api.onSignaling(conversationId, (payload) => {
    void dispatchSignaling(remotePeerId, conversationId, payload);
  });
  signalingUnlistenByConversation.set(conversationId, unlisten);
}

export function teardownConversationSignaling(conversationId: string) {
  const unlisten = signalingUnlistenByConversation.get(conversationId);
  if (unlisten) {
    unlisten();
    signalingUnlistenByConversation.delete(conversationId);
  }
}

async function dispatchSignaling(
  remotePeerId: string,
  conversationId: string,
  wirePayload: string
) {
  const encryptedPayload = unwrapSignalingWire(wirePayload);
  if (!encryptedPayload) {
    return;
  }

  let plaintext: string;
  try {
    plaintext = await api.decryptSignaling(remotePeerId, encryptedPayload);
  } catch {
    return;
  }

  let envelope: SignalingEnvelope;
  try {
    envelope = JSON.parse(plaintext) as SignalingEnvelope;
  } catch {
    return;
  }

  if (
    envelope.from &&
    signalingLocalPeerId &&
    envelope.from === signalingLocalPeerId
  ) {
    return;
  }

  const { from: _from, ...msg } = envelope;

  if (isCallSignal(msg)) {
    await callSignalingHandler?.(remotePeerId, conversationId, msg);
    return;
  }

  if (msg.type === "ice" && msg.candidate) {
    const callPeer = callPeers.get(remotePeerId);
    if (callPeer?.conversationId === conversationId) {
      await addIceCandidateToPeer(callPeer, msg.candidate);
      return;
    }
    const textPeer = peers.get(remotePeerId);
    if (textPeer?.conversationId === conversationId) {
      try {
        await textPeer.pc.addIceCandidate(msg.candidate);
      } catch {
        /* ignore late ICE */
      }
      return;
    }
    if (textTransportPaused) {
      queueOrphanedCallIce(conversationId, remotePeerId, msg.candidate);
    }
    return;
  }

  const state = peers.get(remotePeerId);
  if (!state || state.conversationId !== conversationId) {
    return;
  }

  await handleTextSignaling(state, msg);
}

function isImpolite(localPeerId: string, remotePeerId: string): boolean {
  return localPeerId > remotePeerId;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function wireBytesFromData(data: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

const SIGNAL_PUBLISH_RETRIES = 10;
const SIGNAL_PUBLISH_RETRY_MS = 350;

function formatPublishError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes("InsufficientPeers")) {
    return "Could not reach your contact on the network yet — keep both devices in the same room and try again";
  }
  return raw || "Could not send call signal";
}

async function publishEncryptedSignaling(
  conversationId: string,
  encrypted: string,
  waitForDelivery: boolean
) {
  if (!waitForDelivery) {
    await api.publishSignaling(conversationId, encrypted, false);
    return;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < SIGNAL_PUBLISH_RETRIES; attempt++) {
    try {
      await api.publishSignaling(conversationId, encrypted, true);
      return;
    } catch (err) {
      lastErr = err;
      const raw = err instanceof Error ? err.message : String(err);
      if (
        !raw.includes("InsufficientPeers") ||
        attempt === SIGNAL_PUBLISH_RETRIES - 1
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, SIGNAL_PUBLISH_RETRY_MS));
    }
  }
  throw new Error(formatPublishError(lastErr));
}

export async function publishSignalingMessage(
  conversationId: string,
  remotePeerId: string,
  msg: SignalingMessage,
  options?: { waitForDelivery?: boolean }
) {
  const body: SignalingEnvelope = signalingLocalPeerId
    ? { ...msg, from: signalingLocalPeerId }
    : msg;
  const encrypted = await api.encryptSignaling(
    remotePeerId,
    JSON.stringify(body)
  );
  await publishEncryptedSignaling(
    conversationId,
    encrypted,
    options?.waitForDelivery ?? true
  );
}

function publishSignalingBestEffort(
  conversationId: string,
  remotePeerId: string,
  msg: SignalingMessage
) {
  void publishSignalingMessage(conversationId, remotePeerId, msg, {
    waitForDelivery: false,
  });
}

async function handleTextSignaling(
  state: PeerConnectionState,
  msg: TextSignalingMessage
) {
  if (textTransportPaused) {
    return;
  }

  const { pc, polite } = state;

  try {
    if (msg.type === "offer" && msg.sdp) {
      const offerCollision = state.makingOffer || pc.signalingState !== "stable";
      state.ignoreOffer = !polite && offerCollision;
      if (state.ignoreOffer) {
        return;
      }
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await publishSignalingMessage(state.conversationId, state.remotePeerId, {
        type: "answer",
        sdp: answer,
      });
    } else if (msg.type === "answer" && msg.sdp) {
      if (state.ignoreOffer) return;
      await pc.setRemoteDescription(msg.sdp);
    } else if (msg.type === "ice" && msg.candidate) {
      if (state.ignoreOffer) return;
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch {
        /* ignore late ICE */
      }
    }
  } catch {
    /* ignore stale signaling */
  }
}

function mergeRemoteTracks(
  state: PeerConnectionState,
  tracks: MediaStreamTrack[]
) {
  if (tracks.length === 0) return;
  let stream = state.remoteMediaStream;
  if (!stream) {
    stream = new MediaStream();
    state.remoteMediaStream = stream;
  }
  let added = false;
  for (const track of tracks) {
    if (!stream.getTracks().some((t) => t.id === track.id)) {
      stream.addTrack(track);
      track.enabled = true;
      added = true;
    }
  }
  if (added) {
    state.onRemoteTrack?.(stream);
  }
}

function tracksFromTrackEvent(ev: RTCTrackEvent): MediaStreamTrack[] {
  const fromStream = ev.streams?.[0]?.getTracks();
  if (fromStream?.length) {
    return fromStream;
  }
  return ev.track ? [ev.track] : [];
}

/** Replay tracks already on the PC (e.g. after setRemoteDescription). */
export function syncCallRemoteTracks(state: PeerConnectionState): void {
  const tracks = state.pc
    .getReceivers()
    .map((r) => r.track)
    .filter((t): t is MediaStreamTrack => t != null && t.readyState !== "ended");
  mergeRemoteTracks(state, tracks);
}

function attachDataChannel(state: PeerConnectionState, dc: RTCDataChannel) {
  state.channel = dc;

  dc.onopen = () => {
    notifyTextChannelListeners();
  };

  dc.onclose = () => {
    if (state.channel === dc) {
      state.channel = null;
      notifyTextChannelListeners();
    }
  };

  dc.onmessage = (ev) => {
    const wireBytes = wireBytesFromData(
      ev.data as string | ArrayBuffer | ArrayBufferView
    );
    const wireBase64 = bytesToBase64(wireBytes);
    void api.ingestDcMessage(state.remotePeerId, wireBase64);
  };
}

async function wirePeerConnection(
  state: PeerConnectionState,
  options: { textChannel: boolean }
) {
  const { pc, conversationId, remotePeerId } = state;

  await ensureConversationSignaling(conversationId, remotePeerId);

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    if (!options.textChannel) {
      if (!state.callIceReady) {
        state.pendingLocalIce.push(ev.candidate.toJSON());
        return;
      }
    }
    publishSignalingBestEffort(conversationId, remotePeerId, {
      type: "ice",
      candidate: ev.candidate.toJSON(),
    });
  };

  if (options.textChannel) {
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === TEXT_CHANNEL_LABEL) {
        attachDataChannel(state, ev.channel);
      }
    };
  }

  pc.ontrack = (ev) => {
    if (options.textChannel) {
      const stream = ev.streams[0];
      if (stream) {
        state.onRemoteTrack?.(stream);
      }
      return;
    }
    mergeRemoteTracks(state, tracksFromTrackEvent(ev));
  };

  if (!options.textChannel) {
    pc.oniceconnectionstatechange = () => {
      const ice = pc.iceConnectionState;
      if (ice === "connected" || ice === "completed") {
        syncCallRemoteTracks(state);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        syncCallRemoteTracks(state);
      }
    };
  } else {
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        /* keep PC for retry */
      }
    };
  }
}

export async function createPeerConnection(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string
): Promise<PeerConnectionState> {
  const polite = !isImpolite(localPeerId, remotePeerId);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  const state: PeerConnectionState = {
    pc,
    conversationId,
    remotePeerId,
    localPeerId,
    polite,
    makingOffer: false,
    ignoreOffer: false,
    channel: null,
    onRemoteTrack: null,
    pendingIce: [],
    pendingLocalIce: [],
    callIceReady: false,
    remoteMediaStream: null,
  };

  await wirePeerConnection(state, { textChannel: true });
  peers.set(remotePeerId, state);
  return state;
}

async function createCallPeerConnection(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string
): Promise<PeerConnectionState> {
  const polite = !isImpolite(localPeerId, remotePeerId);
  const pc = new RTCPeerConnection({ iceServers: CALL_ICE_SERVERS });

  const state: PeerConnectionState = {
    pc,
    conversationId,
    remotePeerId,
    localPeerId,
    polite,
    makingOffer: false,
    ignoreOffer: false,
    channel: null,
    onRemoteTrack: null,
    pendingIce: [],
    pendingLocalIce: [],
    callIceReady: false,
    remoteMediaStream: null,
  };

  await wirePeerConnection(state, { textChannel: false });
  callPeers.set(remotePeerId, state);
  return state;
}

export function getPeerConnection(
  remotePeerId: string
): PeerConnectionState | undefined {
  return peers.get(remotePeerId);
}

export async function ensurePeerConnection(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string
): Promise<PeerConnectionState> {
  let state = peers.get(remotePeerId);
  if (!state) {
    state = await createPeerConnection(localPeerId, remotePeerId, conversationId);
  } else if (state.conversationId !== conversationId) {
    closePeerConnection(remotePeerId);
    state = await createPeerConnection(localPeerId, remotePeerId, conversationId);
  }
  return state;
}

export function getCallPeerConnection(
  remotePeerId: string
): PeerConnectionState | undefined {
  return callPeers.get(remotePeerId);
}

export function closeCallPeerConnection(remotePeerId: string): void {
  const state = callPeers.get(remotePeerId);
  if (!state) return;
  state.remoteMediaStream = null;
  state.onRemoteTrack = null;
  state.pc.close();
  callPeers.delete(remotePeerId);
}

/** Dedicated peer connection for calls so text negotiation cannot block signaling. */
export async function ensureCallPeerConnection(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string
): Promise<PeerConnectionState> {
  closeCallPeerConnection(remotePeerId);
  return createCallPeerConnection(localPeerId, remotePeerId, conversationId);
}

export async function ensureTextTransport(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string
): Promise<void> {
  if (textTransportPaused) {
    return;
  }
  const state = await ensurePeerConnection(
    localPeerId,
    remotePeerId,
    conversationId
  );
  const { pc, polite } = state;

  if (!polite && pc.signalingState === "stable" && !state.channel) {
    const dc = pc.createDataChannel(TEXT_CHANNEL_LABEL, { ordered: true });
    attachDataChannel(state, dc);

    state.makingOffer = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await publishSignalingMessage(conversationId, remotePeerId, {
        type: "offer",
        sdp: offer,
      });
    } finally {
      state.makingOffer = false;
    }
  }
}

export function isTextChannelOpen(peerId: string): boolean {
  const state = peers.get(peerId);
  return state?.channel?.readyState === "open";
}

export type SendTextResult = {
  via: "dc" | "gossipsub";
  message: Message;
};

async function sendViaGossipsub(
  peerId: string,
  body: string
): Promise<Message> {
  return api.sendMessage(peerId, body);
}

async function sendViaDataChannel(
  peerId: string,
  body: string
): Promise<Message> {
  const { wireBase64, messageId } = await api.prepareWireMessage(
    peerId,
    body
  );
  const wireBytes = Uint8Array.from(atob(wireBase64), (c) => c.charCodeAt(0));
  const state = peers.get(peerId);
  const dc = state?.channel;
  if (!dc || dc.readyState !== "open") {
    throw new Error("data channel not open");
  }
  dc.send(wireBytes);
  await api.markOutgoingSent(peerId, messageId);
  const messages = await api.listMessages(peerId);
  const message = messages.find((m) => m.id === messageId);
  if (!message) {
    throw new Error("message not found after send");
  }
  return message;
}

export async function sendTextMessage(
  localPeerId: string,
  peerId: string,
  conversationId: string,
  body: string
): Promise<SendTextResult> {
  const dcOpen = isTextChannelOpen(peerId);
  if (dcOpen) {
    try {
      const message = await sendViaDataChannel(peerId, body);
      return { via: "dc", message };
    } catch {
      resetTextTransport(peerId);
    }
  }

  void ensureTextTransport(localPeerId, peerId, conversationId);

  const message = await sendViaGossipsub(peerId, body);
  return { via: "gossipsub", message };
}

export function resetTextTransport(peerId: string): void {
  closePeerConnection(peerId);
}

export function closePeerConnection(peerId: string): void {
  const state = peers.get(peerId);
  if (!state) return;

  state.channel?.close();
  state.pc.close();
  peers.delete(peerId);
  notifyTextChannelListeners();
}

/** Stops media tracks but keeps the peer connection for text. */
export function stopMediaTracks(peerId: string) {
  const state = callPeers.get(peerId) ?? peers.get(peerId);
  if (!state) return;
  for (const sender of state.pc.getSenders()) {
    sender.track?.stop();
  }
}

export function closeTextTransport(peerId: string): void {
  closePeerConnection(peerId);
}

/** @deprecated use isTextChannelOpen */
export function getDataChannel(peerId: string): RTCDataChannel | undefined {
  return peers.get(peerId)?.channel ?? undefined;
}
