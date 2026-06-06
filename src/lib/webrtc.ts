import "./transport/register";

export type {
  CallSignalingMessage,
  CallPeerState,
  SendTextResult,
  SignalingEnvelope,
  SignalingMessage,
  TextSignalingMessage,
  TextPeerState,
} from "./transport/types";
export { isCallSignal } from "./transport/types";

export {
  applyRemoteDescription,
  CALL_ICE_GATHER_TIMEOUT_MS,
  CALL_ICE_SERVERS,
  ICE_SERVERS,
  parseSessionDescription,
  sessionDescriptionPayload,
  TEXT_CHANNEL_LABEL,
  waitForIceGathering,
} from "./transport/rtc-utils";

export {
  clearOrphanedCallIce,
  closeCallPeerConnection,
  ensureCallPeerConnection,
  flushOrphanedCallIce,
  flushPendingIce,
  flushPendingLocalIce,
  getCallPeerConnection,
  setCallIceReady,
  stopCallMediaTracks as stopMediaTracks,
  syncCallRemoteTracks,
} from "./transport/call-peer";

export {
  ensureConversationSignaling,
  publishSignalingMessage,
  registerSignalingRoutes,
  setSignalingLocalPeerId,
  teardownConversationSignaling,
} from "./transport/signaling";

export {
  closePeerConnection,
  closeTextTransport,
  ensurePeerConnection,
  ensureTextTransport,
  getDataChannel,
  getPeerConnection,
  isTextChannelOpen,
  resetTextTransport,
  sendTextMessage,
  setTextTransportPaused,
  subscribeTextChannelState,
} from "./transport/text-peer";
