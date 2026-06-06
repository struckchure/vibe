import {
  addIceCandidate,
  clearOrphanIce,
  flushIceToPeer,
  getOrphanIceBuffer,
  IceBuffer,
} from "./ice-buffer";
import {
  publishSignalingBestEffort,
  ensureConversationSignaling,
} from "./signaling";
import { CALL_ICE_SERVERS } from "./rtc-utils";
import type { CallPeerState } from "./types";

const callPeers = new Map<string, CallPeerState>();
const inboundIce = new Map<string, IceBuffer>();
const outboundIce = new Map<string, IceBuffer>();

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

function mergeRemoteTracks(state: CallPeerState, tracks: MediaStreamTrack[]) {
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
export function syncCallRemoteTracks(state: CallPeerState): void {
  const tracks = state.pc
    .getReceivers()
    .map((r) => r.track)
    .filter((t): t is MediaStreamTrack => t != null && t.readyState !== "ended");
  mergeRemoteTracks(state, tracks);
}

function wireCallPeerConnection(state: CallPeerState) {
  const { pc, conversationId, remotePeerId } = state;

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    if (!state.callIceReady) {
      getOutboundIce(remotePeerId).enqueue(ev.candidate.toJSON());
      return;
    }
    publishSignalingBestEffort(conversationId, remotePeerId, {
      type: "ice",
      candidate: ev.candidate.toJSON(),
    });
  };

  pc.ontrack = (ev) => {
    mergeRemoteTracks(state, tracksFromTrackEvent(ev));
  };

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
}

async function createCallPeerConnection(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string
): Promise<CallPeerState> {
  const pc = new RTCPeerConnection({ iceServers: CALL_ICE_SERVERS });

  const state: CallPeerState = {
    pc,
    conversationId,
    remotePeerId,
    localPeerId,
    makingOffer: false,
    callIceReady: false,
    onRemoteTrack: null,
    remoteMediaStream: null,
  };

  await ensureConversationSignaling(conversationId, remotePeerId);
  wireCallPeerConnection(state);
  callPeers.set(remotePeerId, state);
  return state;
}

export function getCallPeerConnection(
  remotePeerId: string
): CallPeerState | undefined {
  return callPeers.get(remotePeerId);
}

export function closeCallPeerConnection(remotePeerId: string): void {
  const state = callPeers.get(remotePeerId);
  if (!state) return;
  state.remoteMediaStream = null;
  state.onRemoteTrack = null;
  state.pc.close();
  callPeers.delete(remotePeerId);
  inboundIce.delete(remotePeerId);
  outboundIce.delete(remotePeerId);
}

/** Dedicated peer connection for calls so text negotiation cannot block signaling. */
export async function ensureCallPeerConnection(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string
): Promise<CallPeerState> {
  closeCallPeerConnection(remotePeerId);
  return createCallPeerConnection(localPeerId, remotePeerId, conversationId);
}

export function setCallIceReady(remotePeerId: string, ready: boolean) {
  const state = callPeers.get(remotePeerId);
  if (state) {
    state.callIceReady = ready;
  }
}

export function clearOrphanedCallIce(
  conversationId: string,
  remotePeerId: string
) {
  clearOrphanIce(conversationId, remotePeerId);
}

export async function flushOrphanedCallIce(state: CallPeerState) {
  const orphan = getOrphanIceBuffer(state.conversationId, state.remotePeerId);
  await flushIceToPeer(state.pc, orphan);
}

export async function flushPendingIce(state: CallPeerState) {
  if (!state.pc.remoteDescription) {
    return;
  }
  await flushOrphanedCallIce(state);
  await flushIceToPeer(state.pc, getInboundIce(state.remotePeerId));
}

/** Publish outbound ICE queued before callLeg was ready (testclient flushPendingLocalIce). */
export async function flushPendingLocalIce(remotePeerId: string) {
  const state = callPeers.get(remotePeerId);
  if (!state) return;
  const queued = getOutboundIce(remotePeerId).drain();
  for (const candidate of queued) {
    publishSignalingBestEffort(state.conversationId, state.remotePeerId, {
      type: "ice",
      candidate,
    });
  }
}

export async function handleCallIce(
  remotePeerId: string,
  conversationId: string,
  candidate: RTCIceCandidateInit
): Promise<boolean> {
  const state = callPeers.get(remotePeerId);
  if (state?.conversationId === conversationId) {
    await addIceCandidate(state.pc, getInboundIce(remotePeerId), candidate);
    return true;
  }
  return false;
}

export function queueOrphanedCallIce(
  conversationId: string,
  remotePeerId: string,
  candidate: RTCIceCandidateInit
) {
  getOrphanIceBuffer(conversationId, remotePeerId).enqueue(candidate);
}

/** Stops media tracks on the call peer connection. */
export function stopCallMediaTracks(peerId: string) {
  const state = callPeers.get(peerId);
  if (!state) return;
  for (const sender of state.pc.getSenders()) {
    sender.track?.stop();
  }
}
