import { toast } from "sonner";

import type { CallOutcome } from "@/types/chat";
import type { ActiveCall, CallMedia, CallPhase } from "@/types/call";
import * as api from "@/lib/tauri";
import {
  type CallSignalingMessage,
  closeCallPeerConnection,
  ensureCallPeerConnection,
  ensureConversationSignaling,
  getCallPeerConnection,
  publishSignalingMessage,
  registerCallSignalingHandler,
  setTextTransportPaused,
  stopMediaTracks,
} from "@/lib/webrtc";

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
  } | null;
};

const state: CallState = {
  active: null,
  localStream: null,
  remoteStream: null,
  pendingIncoming: null,
};

const listeners = new Set<() => void>();

let contactsByPeer = new Map<string, ContactInfo>();
let incomingToastId: string | number | null = null;

function dismissIncomingToast() {
  if (incomingToastId != null) {
    toast.dismiss(incomingToastId);
    incomingToastId = null;
  }
}

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
  state.active = { ...state.active, phase, connectedAt };
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
      video: media === "video",
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

function attachLocalTracks(
  peerId: string,
  stream: MediaStream
) {
  const peer = getCallPeerConnection(peerId);
  if (!peer) return;
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
  cleanupMedia(peerId);
  closeCallPeerConnection(peerId);
  state.pendingIncoming = null;
  state.active = null;
  notify();
}

function callOfferOptions(_media: CallMedia): RTCOfferOptions {
  return {};
}

function callAnswerOptions(_media: CallMedia): RTCAnswerOptions {
  return {};
}

async function handleCallSignaling(
  remotePeerId: string,
  conversationId: string,
  msg: CallSignalingMessage
) {
  const contact = contactsByPeer.get(remotePeerId);
  const displayName = contact?.displayName ?? remotePeerId.slice(0, 8);

  if (msg.type === "call-invite") {
    if (
      state.active?.peerId === remotePeerId &&
      state.active.phase === "incoming"
    ) {
      return;
    }
    if (isCallBusy()) {
      await publishSignalingMessage(conversationId, remotePeerId, {
        type: "call-decline",
      });
      return;
    }
    state.pendingIncoming = {
      peerId: remotePeerId,
      displayName,
      conversationId,
      media: msg.media,
      sdp: msg.sdp,
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
    };
    dismissIncomingToast();
    incomingToastId = toast.info(
      `Incoming ${msg.media === "video" ? "video" : "voice"} call from ${displayName}`,
      { duration: 60_000 }
    );
    notify();
    return;
  }

  if (msg.type === "call-answer" && state.active?.peerId === remotePeerId) {
    const peer = getCallPeerConnection(remotePeerId);
    if (!peer) return;
    if (peer.pc.remoteDescription?.type === "answer") {
      return;
    }
    try {
      await peer.pc.setRemoteDescription(msg.sdp);
      setPhase("connecting");
    } catch {
      await endCallInternal(false);
    }
    return;
  }

  if (msg.type === "call-decline" && state.active?.peerId === remotePeerId) {
    dismissIncomingToast();
    const active = state.active;
    const outcome: CallOutcome =
      active.direction === "outgoing" ? "missed" : "declined";
    if (active.signaled) {
      await persistCallHistory(active, outcome);
    }
    setTextTransportPaused(false);
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
    await endCallInternal(false);
  }
}

export async function setupCallSignaling(
  _localId: string,
  contacts: ContactInfo[]
) {
  contactsByPeer = new Map(contacts.map((c) => [c.peerId, c]));

  registerCallSignalingHandler(handleCallSignaling);

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
  if (
    state.active &&
    (state.active.phase === "outgoing" || state.active.phase === "ended") &&
    !state.active.signaled
  ) {
    abortActiveCall(state.active.peerId);
  }

  if (isCallBusy()) {
    throw new Error("already in a call");
  }

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

  state.active = {
    peerId: contact.peerId,
    displayName: contact.displayName,
    conversationId: contact.conversationId,
    media,
    direction: "outgoing",
    phase: "outgoing",
    startedAt: Date.now(),
    connectedAt: null,
    signaled: false,
  };
  notify();

  let peer: Awaited<ReturnType<typeof ensureCallPeerConnection>>;
  try {
    peer = await ensureCallPeerConnection(
      localId,
      contact.peerId,
      contact.conversationId
    );

    peer.onRemoteTrack = (stream) => {
      state.remoteStream = stream;
      if (state.active?.peerId === contact.peerId) {
        setPhase("active");
      }
      notify();
    };

    peer.pc.onconnectionstatechange = () => {
      if (
        peer.pc.connectionState === "connected" &&
        state.active?.peerId === contact.peerId
      ) {
        setPhase("active");
      }
    };

    const stream = await getUserMedia(media);
    state.localStream = stream;
    attachLocalTracks(contact.peerId, stream);

    peer.makingOffer = true;
    try {
      const offer = await peer.pc.createOffer(callOfferOptions(media));
      await peer.pc.setLocalDescription(offer);
      await publishSignalingMessage(
        contact.conversationId,
        contact.peerId,
        {
          type: "call-invite",
          media,
          sdp: offer,
        },
        { waitForDelivery: true }
      );
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

  dismissIncomingToast();

  await api.startNetwork();
  await api.subscribeConversation(incoming.conversationId);

  setTextTransportPaused(true);

  try {
    const peer = await ensureCallPeerConnection(
      localId,
      incoming.peerId,
      incoming.conversationId
    );

    peer.onRemoteTrack = (stream) => {
      state.remoteStream = stream;
      setPhase("active");
      notify();
    };

    peer.pc.onconnectionstatechange = () => {
      if (peer.pc.connectionState === "connected") {
        setPhase("active");
      }
    };

    const stream = await getUserMedia(incoming.media);
    state.localStream = stream;
    attachLocalTracks(incoming.peerId, stream);

    await peer.pc.setRemoteDescription(incoming.sdp);
    const answer = await peer.pc.createAnswer(
      callAnswerOptions(incoming.media)
    );
    await peer.pc.setLocalDescription(answer);

    await publishSignalingMessage(
      incoming.conversationId,
      incoming.peerId,
      {
        type: "call-answer",
        sdp: answer,
      }
    );

    state.pendingIncoming = null;
    state.active = {
      ...state.active,
      direction: "incoming",
      phase: "connecting",
      startedAt: Date.now(),
      connectedAt: state.active.connectedAt,
      signaled: true,
    };
    notify();
  } catch (err) {
    dismissIncomingToast();
    abortActiveCall(incoming.peerId);
    throw err;
  }
}

export async function declineCall() {
  const incoming = state.pendingIncoming;
  if (!incoming) return;

  dismissIncomingToast();

  if (state.active?.signaled) {
    await persistCallHistory(state.active, "declined");
  }

  setTextTransportPaused(false);
  closeCallPeerConnection(incoming.peerId);

  await publishSignalingMessage(
    incoming.conversationId,
    incoming.peerId,
    { type: "call-decline" }
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
  if (!active) return;

  dismissIncomingToast();

  if (active.signaled && active.phase !== "outgoing") {
    await persistCallHistory(active, resolveHangupOutcome(active));
  }

  if (sendSignal) {
    try {
      await publishSignalingMessage(
        active.conversationId,
        active.peerId,
        { type: "call-end" }
      );
    } catch {
      /* offline */
    }
  }

  setTextTransportPaused(false);
  cleanupMedia(active.peerId);
  const peer = getCallPeerConnection(active.peerId);
  if (peer) {
    peer.onRemoteTrack = null;
  }
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
