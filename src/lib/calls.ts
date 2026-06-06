import {
  applyRemoteDescription,
  CALL_ICE_GATHER_TIMEOUT_MS,
  type CallSignalingMessage,
  closeCallPeerConnection,
  ensureCallPeerConnection,
  ensureConversationSignaling,
  clearOrphanedCallIce,
  flushPendingIce,
  flushPendingLocalIce,
  getCallPeerConnection,
  publishSignalingMessage,
  syncCallRemoteTracks,
  registerSignalingRoutes,
  sessionDescriptionPayload,
  setCallIceReady,
  setSignalingLocalPeerId,
  setTextTransportPaused,
  stopMediaTracks,
  waitForIceGathering,
} from "@/lib/webrtc";

import type { CallOutcome } from "@/types/chat";
import type { ActiveCall, CallMedia, CallPhase } from "@/types/call";
import * as api from "@/lib/tauri";

type ContactInfo = {
  peerId: string;
  displayName: string;
  conversationId: string;
};

type CallState = {
  active: ActiveCall | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  pendingIncoming: {
    peerId: string;
    displayName: string;
    conversationId: string;
    media: CallMedia;
    sdp: RTCSessionDescriptionInit;
    callLeg: number;
  } | null;
};

let nextCallLeg = 1;

function allocCallLeg(): number {
  return nextCallLeg++;
}

function expectedCallLeg(): number | null {
  return state.active?.callLeg ?? state.pendingIncoming?.callLeg ?? null;
}

function callLegMatches(msg: { callLeg?: number }): boolean {
  const expected = expectedCallLeg();
  if (expected == null || msg.callLeg == null) {
    return false;
  }
  return msg.callLeg === expected;
}

const state: CallState = {
  active: null,
  localStream: null,
  remoteStream: null,
  pendingIncoming: null,
};

const listeners = new Set<() => void>();

let contactsByPeer = new Map<string, ContactInfo>();
let endingCall = false;

/** Serialize call signaling per peer so answer finishes before decline/end. */
const signalingChain = new Map<string, Promise<void>>();

function enqueueCallSignaling(
  peerId: string,
  fn: () => Promise<void>
): Promise<void> {
  const prev = signalingChain.get(peerId) ?? Promise.resolve();
  const next = prev.then(fn).catch(() => {});
  signalingChain.set(peerId, next);
  return next;
}

function wireCallRemoteTracks(peerId: string) {
  const peer = getCallPeerConnection(peerId);
  if (!peer) return;
  peer.onRemoteTrack = (stream) => {
    state.remoteStream = stream;
    notify();
  };
}

export type IncomingCall = NonNullable<CallState["pendingIncoming"]>;

type CallSnapshot = {
  active: ActiveCall | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  pendingIncoming: CallState["pendingIncoming"];
};

let snapshotCache: CallSnapshot = {
  active: null,
  localStream: null,
  remoteStream: null,
  pendingIncoming: null,
};

function rebuildSnapshot() {
  snapshotCache = {
    active: state.active,
    localStream: state.localStream,
    remoteStream: state.remoteStream,
    pendingIncoming: state.pendingIncoming,
  };
}

function notify() {
  rebuildSnapshot();
  for (const fn of listeners) {
    fn();
  }
}

export function subscribeCallState(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCallSnapshot(): CallSnapshot {
  return snapshotCache;
}

function setPhase(phase: CallPhase) {
  if (!state.active) return;
  const connectedAt =
    phase === "active" && state.active.connectedAt == null
      ? Date.now()
      : state.active.connectedAt;
  const startedAt =
    phase === "active" && state.active.startedAt == null
      ? Date.now()
      : state.active.startedAt;
  state.active = { ...state.active, phase, connectedAt, startedAt };
  notify();
}

async function persistCallHistory(active: ActiveCall, outcome: CallOutcome) {
  const durationMs = active.connectedAt
    ? Date.now() - active.connectedAt
    : null;
  let resolved = outcome;
  if (outcome === "completed" && active.connectedAt == null) {
    resolved = active.direction === "outgoing" ? "cancelled" : "missed";
  }
  try {
    await api.recordCallHistory({
      peerId: active.peerId,
      conversationId: active.conversationId,
      outgoing: active.direction === "outgoing",
      media: active.media,
      outcome: resolved,
      durationMs,
    });
  } catch {
    /* ignore when offline */
  }
}

function resolveHangupOutcome(active: ActiveCall): CallOutcome {
  if (active.connectedAt != null) {
    return "completed";
  }
  return active.direction === "outgoing" ? "cancelled" : "missed";
}

async function getUserMedia(media: CallMedia): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone/camera not available in this environment");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: true,
      video:
        media === "video"
          ? {
              facingMode: "user",
              width: { ideal: 640 },
              height: { ideal: 480 },
            }
          : false,
    });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      throw new Error(
        "Microphone/camera permission denied — allow access in system settings"
      );
    }
    if (name === "NotFoundError") {
      throw new Error("No microphone or camera found on this device");
    }
    throw err;
  }
}

function attachLocalTracks(peerId: string, stream: MediaStream) {
  const peer = getCallPeerConnection(peerId);
  if (!peer) return;
  for (const track of stream.getAudioTracks()) {
    track.enabled = true;
  }
  for (const track of stream.getTracks()) {
    peer.pc.addTrack(track, stream);
  }
}

function cleanupMedia(peerId: string) {
  stopMediaTracks(peerId);
  state.localStream?.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  state.remoteStream = null;
}

function abortActiveCall(peerId: string) {
  setTextTransportPaused(false);
  const conversationId =
    state.active?.conversationId ?? state.pendingIncoming?.conversationId;
  if (conversationId) {
    clearOrphanedCallIce(conversationId, peerId);
  }
  cleanupMedia(peerId);
  closeCallPeerConnection(peerId);
  state.pendingIncoming = null;
  state.active = null;
  notify();
}

function callOfferOptions(media: CallMedia): RTCOfferOptions {
  return {
    offerToReceiveAudio: true,
    offerToReceiveVideo: media === "video",
  };
}

function callAnswerOptions(media: CallMedia): RTCAnswerOptions {
  return {
    offerToReceiveAudio: true,
    offerToReceiveVideo: media === "video",
  };
}

/** Decline only applies while still ringing (not after accept/answer). */
function shouldProcessCallDecline(
  active: ActiveCall,
  peerId: string
): boolean {
  if (active.phase === "active") return false;
  if (active.direction === "incoming") {
    return active.phase === "incoming";
  }
  if (active.direction === "outgoing") {
    if (active.phase === "outgoing") return true;
    if (active.phase === "connecting") {
      const peer = getCallPeerConnection(peerId);
      return peer?.pc.remoteDescription?.type !== "answer";
    }
    return false;
  }
  return false;
}

function shouldProcessCallEnd(active: ActiveCall, peerId: string): boolean {
  if (active.phase === "ended") return false;
  if (active.phase === "incoming" || active.phase === "outgoing") {
    return true;
  }
  if (active.phase === "active") return true;
  if (active.phase === "connecting") {
    const peer = getCallPeerConnection(peerId);
    if (active.direction === "outgoing") {
      return peer?.pc.remoteDescription?.type === "answer";
    }
    if (active.direction === "incoming") {
      return peer?.pc.localDescription?.type === "answer";
    }
    return false;
  }
  return false;
}

async function handleCallSignalingImpl(
  remotePeerId: string,
  conversationId: string,
  msg: CallSignalingMessage
) {
  const contact = contactsByPeer.get(remotePeerId);
  const displayName = contact?.displayName ?? remotePeerId.slice(0, 8);

  if (msg.type === "call-invite") {
    if (
      state.active?.peerId === remotePeerId &&
      state.active.phase !== "ended" &&
      state.active.callLeg === msg.callLeg
    ) {
      return;
    }
    if (isCallBusy()) {
      await publishSignalingMessage(conversationId, remotePeerId, {
        type: "call-decline",
        callLeg: msg.callLeg,
      });
      return;
    }

    setTextTransportPaused(true);
    clearOrphanedCallIce(conversationId, remotePeerId);

    state.pendingIncoming = {
      peerId: remotePeerId,
      displayName,
      conversationId,
      media: msg.media,
      sdp: msg.sdp,
      callLeg: msg.callLeg,
    };
    state.active = {
      peerId: remotePeerId,
      displayName,
      conversationId,
      media: msg.media,
      direction: "incoming",
      phase: "incoming",
      startedAt: null,
      connectedAt: null,
      signaled: true,
      callLeg: msg.callLeg,
    };
    notify();
    return;
  }

  if (
    msg.type === "call-answer" &&
    state.active?.peerId === remotePeerId &&
    state.active.direction === "outgoing"
  ) {
    if (!callLegMatches(msg)) {
      return;
    }
    const peer = getCallPeerConnection(remotePeerId);
    if (!peer) return;
    if (peer.pc.remoteDescription?.type === "answer") {
      return;
    }
    const answer = sessionDescriptionPayload(msg.sdp);
    if (!answer) {
      return;
    }
    try {
      await applyRemoteDescription(peer.pc, answer);
      await flushPendingIce(peer);
      syncCallRemoteTracks(peer);
      setPhase("active");
    } catch (err) {
      throw err instanceof Error
        ? err
        : new Error("Could not apply call answer — still connecting");
    }
    return;
  }

  if (msg.type === "call-decline" && state.active?.peerId === remotePeerId) {
    if (!callLegMatches(msg)) {
      return;
    }
    if (!shouldProcessCallDecline(state.active, remotePeerId)) {
      return;
    }
    const active = state.active;
    const outcome: CallOutcome =
      active.direction === "outgoing" ? "missed" : "declined";
    if (active.signaled) {
      await persistCallHistory(active, outcome);
    }
    setTextTransportPaused(false);
    clearOrphanedCallIce(conversationId, remotePeerId);
    cleanupMedia(remotePeerId);
    closeCallPeerConnection(remotePeerId);
    state.active = { ...active, phase: "ended" };
    state.pendingIncoming = null;
    notify();
    setTimeout(() => {
      if (state.active?.phase === "ended") {
        setTextTransportPaused(false);
        state.active = null;
        notify();
      }
    }, 1500);
    return;
  }

  if (msg.type === "call-end" && state.active?.peerId === remotePeerId) {
    if (!callLegMatches(msg)) {
      return;
    }
    if (!shouldProcessCallEnd(state.active, remotePeerId)) {
      return;
    }
    await endCallInternal(false);
  }
}

function handleCallSignaling(
  remotePeerId: string,
  conversationId: string,
  msg: CallSignalingMessage
) {
  void enqueueCallSignaling(remotePeerId, () =>
    handleCallSignalingImpl(remotePeerId, conversationId, msg)
  );
}

export async function setupCallSignaling(
  localId: string,
  contacts: ContactInfo[]
) {
  setSignalingLocalPeerId(localId);
  contactsByPeer = new Map(contacts.map((c) => [c.peerId, c]));

  registerSignalingRoutes({ onCall: handleCallSignaling });

  for (const contact of contacts) {
    await ensureConversationSignaling(
      contact.conversationId,
      contact.peerId
    );
  }
}

export async function startCall(
  localId: string,
  contact: ContactInfo,
  media: CallMedia
) {
  if (state.active) {
    abortActiveCall(state.active.peerId);
  }

  if (isCallBusy()) {
    throw new Error("already in a call");
  }

  setSignalingLocalPeerId(localId);

  const [peers, room] = await Promise.all([
    api.overlayPeerCount(),
    api.roomStatus(),
  ]);
  if (peers === 0 && !room.inRoom) {
    throw new Error(
      "Join a room with your contact before calling (same room code on both devices)"
    );
  }

  await api.startNetwork();
  await api.subscribeConversation(contact.conversationId);

  setTextTransportPaused(true);

  const callLeg = allocCallLeg();
  state.active = {
    peerId: contact.peerId,
    displayName: contact.displayName,
    conversationId: contact.conversationId,
    media,
    direction: "outgoing",
    phase: "outgoing",
    startedAt: null,
    connectedAt: null,
    signaled: false,
    callLeg,
  };
  notify();

  try {
    const stream = await getUserMedia(media);
    state.localStream = stream;

    const peer = await ensureCallPeerConnection(
      localId,
      contact.peerId,
      contact.conversationId
    );

    wireCallRemoteTracks(contact.peerId);
    attachLocalTracks(contact.peerId, stream);

    peer.makingOffer = true;
    try {
      const offer = await peer.pc.createOffer(callOfferOptions(media));
      await peer.pc.setLocalDescription(offer);
      await waitForIceGathering(peer.pc, CALL_ICE_GATHER_TIMEOUT_MS);
      const inviteSdp =
        sessionDescriptionPayload(peer.pc.localDescription) ?? offer;
      await publishSignalingMessage(
        contact.conversationId,
        contact.peerId,
        {
          type: "call-invite",
          media,
          sdp: inviteSdp,
          callLeg,
        },
        { waitForDelivery: true }
      );
      setCallIceReady(contact.peerId, true);
      await flushPendingLocalIce(contact.peerId);
      if (state.active) {
        state.active = { ...state.active, signaled: true };
      }
      setPhase("connecting");
    } finally {
      peer.makingOffer = false;
    }
  } catch (err) {
    abortActiveCall(contact.peerId);
    throw err;
  }
}

export async function acceptCall(localId: string) {
  const incoming = state.pendingIncoming;
  if (!incoming || !state.active) {
    throw new Error("no incoming call");
  }

  setSignalingLocalPeerId(localId);

  setPhase("connecting");

  await api.startNetwork();
  await api.subscribeConversation(incoming.conversationId);

  setTextTransportPaused(true);

  let peer: Awaited<ReturnType<typeof ensureCallPeerConnection>> | undefined;
  try {
    peer = await ensureCallPeerConnection(
      localId,
      incoming.peerId,
      incoming.conversationId
    );

    wireCallRemoteTracks(incoming.peerId);
    setCallIceReady(incoming.peerId, true);

    const stream = await getUserMedia(incoming.media);
    state.localStream = stream;
    attachLocalTracks(incoming.peerId, stream);

    await applyRemoteDescription(peer.pc, incoming.sdp);
    await flushPendingIce(peer);

    const answer = await peer.pc.createAnswer(
      callAnswerOptions(incoming.media)
    );
    await peer.pc.setLocalDescription(answer);
    await waitForIceGathering(peer.pc, CALL_ICE_GATHER_TIMEOUT_MS);

    const answerSdp =
      sessionDescriptionPayload(peer.pc.localDescription) ?? answer;
    await publishSignalingMessage(
      incoming.conversationId,
      incoming.peerId,
      {
        type: "call-answer",
        sdp: answerSdp,
        callLeg: incoming.callLeg,
      },
      { waitForDelivery: false }
    );
    await flushPendingLocalIce(incoming.peerId);

    state.pendingIncoming = null;
    if (state.active) {
      state.active = {
        ...state.active,
        direction: "incoming",
        signaled: true,
      };
    }
    syncCallRemoteTracks(peer);
    setPhase("active");
  } catch (err) {
    const callPeer = peer ?? getCallPeerConnection(incoming.peerId);
    const answeredLocally =
      callPeer?.pc.localDescription?.type === "answer";
    if (!answeredLocally) {
      try {
        await publishSignalingMessage(
          incoming.conversationId,
          incoming.peerId,
          { type: "call-decline", callLeg: incoming.callLeg }
        );
      } catch {
        /* offline */
      }
    }
    abortActiveCall(incoming.peerId);
    throw err;
  }
}

export async function declineCall() {
  const incoming = state.pendingIncoming;
  if (!incoming) return;
  if (state.active?.phase !== "incoming") return;


  if (state.active?.signaled) {
    await persistCallHistory(state.active, "declined");
  }

  setTextTransportPaused(false);
  clearOrphanedCallIce(incoming.conversationId, incoming.peerId);
  cleanupMedia(incoming.peerId);
  closeCallPeerConnection(incoming.peerId);

  await publishSignalingMessage(
    incoming.conversationId,
    incoming.peerId,
    { type: "call-decline", callLeg: incoming.callLeg }
  );

  state.pendingIncoming = null;
  state.active = null;
  notify();
}

export async function endCall() {
  await endCallInternal(true);
}

async function endCallInternal(sendSignal: boolean) {
  const active = state.active;
  if (!active || endingCall) return;
  endingCall = true;

  if (active.phase === "incoming") {
  } else {
  }

  if (active.signaled && active.phase !== "outgoing") {
    await persistCallHistory(active, resolveHangupOutcome(active));
  }

  if (sendSignal && active.signaled) {
    try {
      await publishSignalingMessage(
        active.conversationId,
        active.peerId,
        { type: "call-end", callLeg: active.callLeg }
      );
    } catch {
      /* offline */
    }
  }

  setTextTransportPaused(false);
  clearOrphanedCallIce(active.conversationId, active.peerId);
  cleanupMedia(active.peerId);
  closeCallPeerConnection(active.peerId);

  state.pendingIncoming = null;
  state.active = { ...active, phase: "ended" };
  notify();

  setTimeout(() => {
    if (state.active?.phase === "ended") {
      setTextTransportPaused(false);
      state.active = null;
      notify();
    }
    endingCall = false;
  }, 800);
}

export function toggleMute(): boolean {
  const audio = state.localStream?.getAudioTracks()[0];
  if (!audio) return false;
  audio.enabled = !audio.enabled;
  notify();
  return !audio.enabled;
}

export function toggleCamera(): boolean {
  const video = state.localStream?.getVideoTracks()[0];
  if (!video) return false;
  video.enabled = !video.enabled;
  notify();
  return !video.enabled;
}

export function isCallBusy(): boolean {
  if (!state.active) return false;
  return (
    state.active.phase !== "idle" && state.active.phase !== "ended"
  );
}
