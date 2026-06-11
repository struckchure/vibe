import { addIceCandidate, clearOrphanIce, flushIceToPeer, getOrphanIceBuffer, IceBuffer } from "./ice-buffer";
import {
  attachSignalingChannel,
  detachSignalingChannel,
  ensureConversationSignaling,
  publishSignalingBestEffort,
  publishSignalingMessage,
} from "./signaling";
import { resolveIceServers } from "@/lib/ice-config";
import {
  attachNoiseChannel,
  bootstrapNoiseHandshake,
  clearNoiseHandshake,
} from "./noise-handshake";
import {
  isImpolite,
  NOISE_CHANNEL_LABEL,
  sessionDescriptionPayload,
  SIGNAL_CHANNEL_LABEL,
  TEXT_CHANNEL_LABEL,
  waitForIceGathering,
} from "./rtc-utils";
import type { SendTextResult, TextSignalingMessage } from "./types";
import { ingestDataChannelMessage, sendViaDataChannel } from "./wire";
import * as api from "@/lib/tauri";

export type PeerConnectionState = {
  pc: RTCPeerConnection;
  conversationId: string;
  remotePeerId: string;
  localPeerId: string;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  channel: RTCDataChannel | null;
  signalChannel: RTCDataChannel | null;
  noiseChannel: RTCDataChannel | null;
  callIceReady: boolean;
  onRemoteTrack: ((stream: MediaStream) => void) | null;
  remoteMediaStream: MediaStream | null;
  localTracks: MediaStreamTrack[];
};

export type SdpExchangePayload = {
  v: 1;
  peerId: string;
  conversationId: string;
  type: "offer" | "answer";
  sdp: RTCSessionDescriptionInit;
};

const peers = new Map<string, PeerConnectionState>();
const inboundIce = new Map<string, IceBuffer>();
const outboundIce = new Map<string, IceBuffer>();

const transportListeners = new Set<() => void>();
let networkListenersWired = false;

function notifyTransportListeners() {
  for (const fn of transportListeners) {
    fn();
  }
}

function getInboundIce(remotePeerId: string): IceBuffer {
  let buffer = inboundIce.get(remotePeerId);
  if (!buffer) {
    buffer = new IceBuffer();
    inboundIce.set(remotePeerId, buffer);
  }
  return buffer;
}

function getOutboundIce(remotePeerId: string): IceBuffer {
  let buffer = outboundIce.get(remotePeerId);
  if (!buffer) {
    buffer = new IceBuffer();
    outboundIce.set(remotePeerId, buffer);
  }
  return buffer;
}

function mergeRemoteTracks(state: PeerConnectionState, tracks: MediaStreamTrack[]) {
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

export function syncCallRemoteTracks(state: PeerConnectionState): void {
  const tracks = state.pc
    .getReceivers()
    .map((r) => r.track)
    .filter((t): t is MediaStreamTrack => t != null && t.readyState !== "ended");
  mergeRemoteTracks(state, tracks);
}

function attachTextChannel(state: PeerConnectionState, dc: RTCDataChannel) {
  state.channel = dc;
  dc.onopen = () => notifyTransportListeners();
  dc.onclose = () => {
    if (state.channel === dc) {
      state.channel = null;
      notifyTransportListeners();
    }
  };
  dc.onmessage = (ev) => {
    ingestDataChannelMessage(
      state.remotePeerId,
      ev.data as string | ArrayBuffer | ArrayBufferView
    );
  };
}

function attachSignalChannel(state: PeerConnectionState, dc: RTCDataChannel) {
  state.signalChannel = dc;
  attachSignalingChannel(state.remotePeerId, state.conversationId, dc);
  dc.onopen = () => notifyTransportListeners();
  dc.onclose = () => {
    if (state.signalChannel === dc) {
      state.signalChannel = null;
      detachSignalingChannel(state.remotePeerId);
      notifyTransportListeners();
    }
  };
}

function attachNoiseChannelState(state: PeerConnectionState, dc: RTCDataChannel) {
  state.noiseChannel = dc;
  attachNoiseChannel(state.localPeerId, state.remotePeerId, dc);
  dc.onopen = () => {
    notifyTransportListeners();
    void bootstrapNoiseHandshake(
      state.localPeerId,
      state.remotePeerId,
      dc
    );
  };
  dc.onclose = () => {
    if (state.noiseChannel === dc) {
      state.noiseChannel = null;
      clearNoiseHandshake(state.remotePeerId);
      notifyTransportListeners();
    }
  };
}

function createPeerChannels(state: PeerConnectionState) {
  if (!isImpolite(state.localPeerId, state.remotePeerId)) {
    return;
  }
  if (!state.channel) {
    attachTextChannel(
      state,
      state.pc.createDataChannel(TEXT_CHANNEL_LABEL, { ordered: true })
    );
  }
  if (!state.signalChannel) {
    attachSignalChannel(
      state,
      state.pc.createDataChannel(SIGNAL_CHANNEL_LABEL, { ordered: true })
    );
  }
  if (!state.noiseChannel) {
    attachNoiseChannelState(
      state,
      state.pc.createDataChannel(NOISE_CHANNEL_LABEL, { ordered: true })
    );
  }
}

function wirePeerConnection(state: PeerConnectionState) {
  const { pc, conversationId, remotePeerId } = state;

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    if (!state.callIceReady && state.localTracks.length > 0) {
      getOutboundIce(remotePeerId).enqueue(ev.candidate.toJSON());
      return;
    }
    publishSignalingBestEffort(conversationId, remotePeerId, {
      type: "ice",
      candidate: ev.candidate.toJSON(),
    });
  };

  pc.ondatachannel = (ev) => {
    const label = ev.channel.label;
    if (label === TEXT_CHANNEL_LABEL) {
      attachTextChannel(state, ev.channel);
    } else if (label === SIGNAL_CHANNEL_LABEL) {
      attachSignalChannel(state, ev.channel);
    } else if (label === NOISE_CHANNEL_LABEL) {
      attachNoiseChannelState(state, ev.channel);
    }
  };

  pc.ontrack = (ev) => {
    mergeRemoteTracks(state, tracksFromTrackEvent(ev));
  };

  pc.oniceconnectionstatechange = () => {
    const ice = pc.iceConnectionState;
    if (ice === "connected" || ice === "completed") {
      syncCallRemoteTracks(state);
    }
    notifyTransportListeners();
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      syncCallRemoteTracks(state);
    }
    notifyTransportListeners();
  };
}

async function createPeerConnection(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string
): Promise<PeerConnectionState> {
  const polite = !isImpolite(localPeerId, remotePeerId);
  const iceServers = await resolveIceServers();
  const pc = new RTCPeerConnection({ iceServers });

  const state: PeerConnectionState = {
    pc,
    conversationId,
    remotePeerId,
    localPeerId,
    polite,
    makingOffer: false,
    ignoreOffer: false,
    channel: null,
    signalChannel: null,
    noiseChannel: null,
    callIceReady: true,
    onRemoteTrack: null,
    remoteMediaStream: null,
    localTracks: [],
  };

  await ensureConversationSignaling(conversationId, remotePeerId);
  wirePeerConnection(state);
  createPeerChannels(state);
  peers.set(remotePeerId, state);
  ensureNetworkListeners();
  return state;
}

function ensureNetworkListeners() {
  if (networkListenersWired || typeof window === "undefined") return;
  networkListenersWired = true;
  const onNetworkChange = () => {
    for (const state of peers.values()) {
      if (state.pc.signalingState === "closed") continue;
      try {
        state.pc.restartIce();
      } catch {
        /* ignore */
      }
    }
  };
  window.addEventListener("online", onNetworkChange);
  const conn = (
    navigator as Navigator & { connection?: { addEventListener: Function } }
  ).connection;
  conn?.addEventListener?.("change", onNetworkChange);
}

export function getPeerConnection(remotePeerId: string): PeerConnectionState | undefined {
  return peers.get(remotePeerId);
}

export const getCallPeerConnection = getPeerConnection;

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

export const ensureCallPeerConnection = ensurePeerConnection;

export async function createConnectionOffer(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string
): Promise<SdpExchangePayload> {
  if (peers.has(remotePeerId)) {
    closePeerConnection(remotePeerId);
  }
  const state = await ensurePeerConnection(localPeerId, remotePeerId, conversationId);
  createPeerChannels(state);
  const offer = await state.pc.createOffer();
  await state.pc.setLocalDescription(offer);
  await waitForIceGathering(state.pc);
  const sdp = sessionDescriptionPayload(state.pc.localDescription) ?? offer;
  return {
    v: 1,
    peerId: localPeerId,
    conversationId,
    type: "offer",
    sdp,
  };
}

export async function applyConnectionAnswer(
  remotePeerId: string,
  payload: SdpExchangePayload
): Promise<void> {
  const state = peers.get(remotePeerId);
  if (!state) {
    throw new Error("no peer connection for answer");
  }
  await state.pc.setRemoteDescription(payload.sdp);
  notifyTransportListeners();
}

export function getTransportPeerIds(): string[] {
  return [...peers.keys()];
}

export function isPeerConnected(peerId: string): boolean {
  const state = peers.get(peerId);
  if (!state) return false;
  const cs = state.pc.connectionState;
  return cs === "connected" || cs === "connecting";
}

export function isTransportReady(peerId: string): boolean {
  return isTextChannelOpen(peerId) || isPeerConnected(peerId);
}

export function isTextChannelOpen(peerId: string): boolean {
  return peers.get(peerId)?.channel?.readyState === "open";
}

export function closePeerConnection(peerId: string): void {
  const state = peers.get(peerId);
  if (!state) return;
  removeCallTracks(peerId);
  state.channel?.close();
  state.signalChannel?.close();
  state.noiseChannel?.close();
  detachSignalingChannel(peerId);
  clearNoiseHandshake(peerId);
  state.pc.close();
  peers.delete(peerId);
  inboundIce.delete(peerId);
  outboundIce.delete(peerId);
  notifyTransportListeners();
}

export const closeCallPeerConnection = closePeerConnection;
export const resetTextTransport = closePeerConnection;
export const closeTextTransport = closePeerConnection;

export function getDataChannel(peerId: string): RTCDataChannel | undefined {
  return peers.get(peerId)?.channel ?? undefined;
}

export function subscribeTransportState(listener: () => void) {
  transportListeners.add(listener);
  return () => transportListeners.delete(listener);
}

export const subscribeTextChannelState = subscribeTransportState;

let textTransportPaused = false;

export function setTextTransportPaused(paused: boolean) {
  textTransportPaused = paused;
}

export async function ensureTextTransport(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string
): Promise<void> {
  if (textTransportPaused) {
    return;
  }
  if (!(await api.isOverlayPeerConnected(remotePeerId))) {
    return;
  }

  const state = await ensurePeerConnection(
    localPeerId,
    remotePeerId,
    conversationId
  );
  const { pc, polite } = state;

  if (!polite && pc.signalingState === "stable" && !state.channel) {
    createPeerChannels(state);
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

export async function sendTextMessage(
  _localPeerId: string,
  peerId: string,
  _conversationId: string,
  body: string
): Promise<SendTextResult> {
  if (!isTextChannelOpen(peerId)) {
    const sentAt = Date.now();
    const messageId = `pending-${sentAt}-${Math.random().toString(36).slice(2, 10)}`;
    const message = await api.persistOutgoingMessage(
      peerId,
      body,
      sentAt,
      messageId
    );
    return { via: "queued", message };
  }

  const channel = peers.get(peerId)?.channel;
  if (!channel) {
    throw new Error("data channel not open");
  }

  try {
    const message = await sendViaDataChannel(peerId, body, channel);
    return { via: "dc", message };
  } catch {
    closePeerConnection(peerId);
    throw new Error("send failed");
  }
}

export async function flushPendingMessages(peerId: string): Promise<void> {
  if (!isTextChannelOpen(peerId)) {
    return;
  }
  const pending = (await api.listPendingOutgoing()).filter(
    (m) => m.peerId === peerId && m.pending
  );
  const channel = peers.get(peerId)?.channel;
  if (!channel) {
    return;
  }
  for (const msg of pending) {
    try {
      const { wireBase64 } = await api.prepareWireMessage(peerId, msg.body);
      const wireBytes = Uint8Array.from(atob(wireBase64), (c) => c.charCodeAt(0));
      if (channel.readyState === "open") {
        channel.send(wireBytes);
        await api.markOutgoingSent(peerId, msg.id);
      }
    } catch {
      break;
    }
  }
}

export async function handleTextSignaling(
  remotePeerId: string,
  conversationId: string,
  msg: TextSignalingMessage
) {
  let state = peers.get(remotePeerId);
  if (
    !state &&
    msg.type === "offer" &&
    msg.sdp &&
    msg.sdp.type &&
    msg.sdp.sdp
  ) {
    const localPeerId = await api.getPeerId();
    state = await ensurePeerConnection(
      localPeerId,
      remotePeerId,
      conversationId
    );
  }
  if (!state || state.conversationId !== conversationId) {
    return;
  }

  const { pc, polite } = state;

  try {
    if (msg.type === "offer" && msg.sdp) {
      const offerCollision =
        state.makingOffer || pc.signalingState !== "stable";
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
      await addIceCandidate(pc, getInboundIce(remotePeerId), msg.candidate);
    }
  } catch {
    /* ignore stale signaling */
  }
}

export async function handlePeerIce(
  remotePeerId: string,
  conversationId: string,
  candidate: RTCIceCandidateInit
): Promise<boolean> {
  const state = peers.get(remotePeerId);
  if (state?.conversationId === conversationId) {
    await addIceCandidate(state.pc, getInboundIce(remotePeerId), candidate);
    return true;
  }
  return false;
}

export const handleTextIce = handlePeerIce;
export const handleCallIce = handlePeerIce;

export function attachLocalCallTracks(peerId: string, stream: MediaStream) {
  const state = peers.get(peerId);
  if (!state) return;
  for (const track of stream.getAudioTracks()) {
    track.enabled = true;
  }
  for (const track of stream.getTracks()) {
    state.pc.addTrack(track, stream);
    state.localTracks.push(track);
  }
}

export function removeCallTracks(peerId: string) {
  const state = peers.get(peerId);
  if (!state) return;
  for (const sender of state.pc.getSenders()) {
    if (sender.track) {
      sender.track.stop();
      state.pc.removeTrack(sender);
    }
  }
  state.localTracks = [];
  state.remoteMediaStream = null;
  state.onRemoteTrack = null;
}

export function stopCallMediaTracks(peerId: string) {
  removeCallTracks(peerId);
}

export function setCallIceReady(remotePeerId: string, ready: boolean) {
  const state = peers.get(remotePeerId);
  if (state) {
    state.callIceReady = ready;
  }
}

export function queueOrphanedCallIce(
  conversationId: string,
  remotePeerId: string,
  candidate: RTCIceCandidateInit
) {
  getOrphanIceBuffer(conversationId, remotePeerId).enqueue(candidate);
}

export function handleOrphanIce(
  conversationId: string,
  remotePeerId: string,
  candidate: RTCIceCandidateInit
) {
  queueOrphanedCallIce(conversationId, remotePeerId, candidate);
}

export function clearOrphanedCallIce(conversationId: string, remotePeerId: string) {
  clearOrphanIce(conversationId, remotePeerId);
}

export async function flushOrphanedCallIce(state: PeerConnectionState) {
  const orphan = getOrphanIceBuffer(state.conversationId, state.remotePeerId);
  await flushIceToPeer(state.pc, orphan);
}

export async function flushPendingIce(state: PeerConnectionState) {
  if (!state.pc.remoteDescription) {
    return;
  }
  await flushOrphanedCallIce(state);
  await flushIceToPeer(state.pc, getInboundIce(state.remotePeerId));
}

export async function flushPendingLocalIce(remotePeerId: string) {
  const state = peers.get(remotePeerId);
  if (!state) return;
  const queued = getOutboundIce(remotePeerId).drain();
  for (const candidate of queued) {
    publishSignalingBestEffort(state.conversationId, state.remotePeerId, {
      type: "ice",
      candidate,
    });
  }
}

export function recycleAllPeerConnections() {
  const ids = [...peers.keys()];
  for (const id of ids) {
    closePeerConnection(id);
  }
}
