import { addIceCandidate, IceBuffer } from "./ice-buffer";
import {
  ensureConversationSignaling,
  publishSignalingBestEffort,
  publishSignalingMessage,
} from "./signaling";
import {
  ICE_SERVERS,
  isImpolite,
  TEXT_CHANNEL_LABEL,
} from "./rtc-utils";
import type { SendTextResult, TextPeerState, TextSignalingMessage } from "./types";
import {
  ingestDataChannelMessage,
  sendViaDataChannel,
  sendViaGossipsub,
} from "./wire";
import { queueOrphanedCallIce } from "./call-peer";

const peers = new Map<string, TextPeerState>();
const inboundIce = new Map<string, IceBuffer>();

let textTransportPaused = false;

const textChannelListeners = new Set<() => void>();

function notifyTextChannelListeners() {
  for (const fn of textChannelListeners) {
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

/** Pause text data-channel negotiation while a voice/video call is active. */
export function setTextTransportPaused(paused: boolean) {
  textTransportPaused = paused;
}

export function isTextTransportPaused() {
  return textTransportPaused;
}

export function subscribeTextChannelState(listener: () => void) {
  textChannelListeners.add(listener);
  return () => textChannelListeners.delete(listener);
}

function attachDataChannel(state: TextPeerState, dc: RTCDataChannel) {
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
    ingestDataChannelMessage(
      state.remotePeerId,
      ev.data as string | ArrayBuffer | ArrayBufferView
    );
  };
}

function wireTextPeerConnection(state: TextPeerState) {
  const { pc, conversationId, remotePeerId } = state;

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    publishSignalingBestEffort(conversationId, remotePeerId, {
      type: "ice",
      candidate: ev.candidate.toJSON(),
    });
  };

  pc.ondatachannel = (ev) => {
    if (ev.channel.label === TEXT_CHANNEL_LABEL) {
      attachDataChannel(state, ev.channel);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      /* keep PC for retry */
    }
  };
}

async function createTextPeerConnection(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string
): Promise<TextPeerState> {
  const polite = !isImpolite(localPeerId, remotePeerId);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  const state: TextPeerState = {
    pc,
    conversationId,
    remotePeerId,
    localPeerId,
    polite,
    makingOffer: false,
    ignoreOffer: false,
    channel: null,
  };

  await ensureConversationSignaling(conversationId, remotePeerId);
  wireTextPeerConnection(state);
  peers.set(remotePeerId, state);
  return state;
}

export function getPeerConnection(
  remotePeerId: string
): TextPeerState | undefined {
  return peers.get(remotePeerId);
}

export async function ensurePeerConnection(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string
): Promise<TextPeerState> {
  let state = peers.get(remotePeerId);
  if (!state) {
    state = await createTextPeerConnection(
      localPeerId,
      remotePeerId,
      conversationId
    );
  } else if (state.conversationId !== conversationId) {
    closePeerConnection(remotePeerId);
    state = await createTextPeerConnection(
      localPeerId,
      remotePeerId,
      conversationId
    );
  }
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

export function closePeerConnection(peerId: string): void {
  const state = peers.get(peerId);
  if (!state) return;

  state.channel?.close();
  state.pc.close();
  peers.delete(peerId);
  inboundIce.delete(peerId);
  notifyTextChannelListeners();
}

export function resetTextTransport(peerId: string): void {
  closePeerConnection(peerId);
}

export function closeTextTransport(peerId: string): void {
  closePeerConnection(peerId);
}

/** @deprecated use isTextChannelOpen */
export function getDataChannel(peerId: string): RTCDataChannel | undefined {
  return peers.get(peerId)?.channel ?? undefined;
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
      const channel = peers.get(peerId)?.channel;
      if (!channel) throw new Error("data channel not open");
      const message = await sendViaDataChannel(peerId, body, channel);
      return { via: "dc", message };
    } catch {
      resetTextTransport(peerId);
    }
  }

  void ensureTextTransport(localPeerId, peerId, conversationId);

  const message = await sendViaGossipsub(peerId, body);
  return { via: "gossipsub", message };
}

export async function handleTextSignaling(
  remotePeerId: string,
  conversationId: string,
  msg: TextSignalingMessage
) {
  if (textTransportPaused) {
    return;
  }

  const state = peers.get(remotePeerId);
  if (!state || state.conversationId !== conversationId) {
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
      await addIceCandidate(pc, getInboundIce(remotePeerId), msg.candidate);
    }
  } catch {
    /* ignore stale signaling */
  }
}

export async function handleTextIce(
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

export function handleOrphanIce(
  conversationId: string,
  remotePeerId: string,
  candidate: RTCIceCandidateInit
) {
  if (textTransportPaused) {
    queueOrphanedCallIce(conversationId, remotePeerId, candidate);
  }
}
