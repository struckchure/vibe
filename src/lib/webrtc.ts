import type { Message } from "@/types/chat";
import * as api from "@/lib/tauri";

const TEXT_CHANNEL_LABEL = "vibe/text";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

type SignalingMessage = {
  type: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type PeerConnectionState = {
  pc: RTCPeerConnection;
  conversationId: string;
  remotePeerId: string;
  localPeerId: string;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  channel: RTCDataChannel | null;
  unlistenSignaling: (() => void) | null;
};

const peers = new Map<string, PeerConnectionState>();

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

async function publishEncryptedSignaling(
  conversationId: string,
  remotePeerId: string,
  msg: SignalingMessage
) {
  const encrypted = await api.encryptSignaling(
    remotePeerId,
    JSON.stringify(msg)
  );
  await api.publishSignaling(conversationId, encrypted);
}

async function handleSignaling(
  state: PeerConnectionState,
  encryptedPayload: string
) {
  let plaintext: string;
  try {
    plaintext = await api.decryptSignaling(state.remotePeerId, encryptedPayload);
  } catch {
    return;
  }

  let msg: SignalingMessage;
  try {
    msg = JSON.parse(plaintext) as SignalingMessage;
  } catch {
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
      await publishEncryptedSignaling(state.conversationId, state.remotePeerId, {
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

  dc.onclose = () => {
    if (state.channel === dc) {
      state.channel = null;
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

async function createPeerState(
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
    unlistenSignaling: null,
  };

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    void publishEncryptedSignaling(conversationId, remotePeerId, {
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
    if (pc.connectionState === "closed" || pc.connectionState === "failed") {
      closeTextTransport(remotePeerId);
    }
  };

  const unlisten = await api.onSignaling(conversationId, (payload) => {
    void handleSignaling(state, payload);
  });
  state.unlistenSignaling = unlisten;

  peers.set(remotePeerId, state);
  return state;
}

export async function ensureTextTransport(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string
): Promise<void> {
  let state = peers.get(remotePeerId);
  if (!state) {
    state = await createPeerState(localPeerId, remotePeerId, conversationId);
  } else if (state.conversationId !== conversationId) {
    closeTextTransport(remotePeerId);
    state = await createPeerState(localPeerId, remotePeerId, conversationId);
  }

  const { pc, polite } = state;

  if (!polite && pc.signalingState === "stable" && !state.channel) {
    const dc = pc.createDataChannel(TEXT_CHANNEL_LABEL, { ordered: true });
    attachDataChannel(state, dc);

    state.makingOffer = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await publishEncryptedSignaling(conversationId, remotePeerId, {
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
  closeTextTransport(peerId);
}

export function closeTextTransport(peerId: string): void {
  const state = peers.get(peerId);
  if (!state) return;

  state.unlistenSignaling?.();
  state.channel?.close();
  state.pc.close();
  peers.delete(peerId);
}

/** @deprecated use isTextChannelOpen */
export function getDataChannel(peerId: string): RTCDataChannel | undefined {
  return peers.get(peerId)?.channel ?? undefined;
}
