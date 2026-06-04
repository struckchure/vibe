import type { Message } from "@/types/chat";
import * as api from "@/lib/tauri";

export const TEXT_CHANNEL_LABEL = "vibe/text";

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

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
    }
  | { type: "call-answer"; sdp: RTCSessionDescriptionInit }
  | { type: "call-decline" }
  | { type: "call-end" };

export type SignalingMessage = TextSignalingMessage | CallSignalingMessage;

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
};

const peers = new Map<string, PeerConnectionState>();
const callPeers = new Map<string, PeerConnectionState>();

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
  encryptedPayload: string
) {
  let plaintext: string;
  try {
    plaintext = await api.decryptSignaling(remotePeerId, encryptedPayload);
  } catch {
    return;
  }

  let msg: SignalingMessage;
  try {
    msg = JSON.parse(plaintext) as SignalingMessage;
  } catch {
    return;
  }

  if (isCallSignal(msg)) {
    await callSignalingHandler?.(remotePeerId, conversationId, msg);
    return;
  }

  if (msg.type === "ice" && msg.candidate) {
    const callPeer = callPeers.get(remotePeerId);
    if (callPeer?.conversationId === conversationId) {
      try {
        await callPeer.pc.addIceCandidate(msg.candidate);
      } catch {
        /* ignore late ICE */
      }
      return;
    }
    const textPeer = peers.get(remotePeerId);
    if (textPeer?.conversationId === conversationId) {
      try {
        await textPeer.pc.addIceCandidate(msg.candidate);
      } catch {
        /* ignore late ICE */
      }
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
  const encrypted = await api.encryptSignaling(
    remotePeerId,
    JSON.stringify(msg)
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
    const stream = ev.streams[0];
    if (stream) {
      state.onRemoteTrack?.(stream);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      /* keep PC for retry */
    }
  };
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

/** Apply the caller's offer on a call PC so ICE can trickle before the callee answers. */
export async function prepareCallPeerForIncomingOffer(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string,
  offer: RTCSessionDescriptionInit
): Promise<PeerConnectionState> {
  let state = callPeers.get(remotePeerId);
  if (!state || state.conversationId !== conversationId) {
    closeCallPeerConnection(remotePeerId);
    state = await createCallPeerConnection(
      localPeerId,
      remotePeerId,
      conversationId
    );
  }

  if (state.pc.signalingState === "have-remote-offer") {
    return state;
  }
  if (state.pc.signalingState === "stable") {
    await state.pc.setRemoteDescription(offer);
    return state;
  }

  closeCallPeerConnection(remotePeerId);
  state = await createCallPeerConnection(
    localPeerId,
    remotePeerId,
    conversationId
  );
  await state.pc.setRemoteDescription(offer);
  return state;
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
