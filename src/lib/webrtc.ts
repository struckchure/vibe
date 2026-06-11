import "./transport/register";

export type {
  CallSignalingMessage,
  SendTextResult,
  SignalingEnvelope,
  SignalingMessage,
  TextSignalingMessage,
} from "./transport/types";
export type { PeerConnectionState, SdpExchangePayload } from "./transport/peer-connection";
export { isCallSignal } from "./transport/types";

export {
  applyRemoteDescription,
  CALL_ICE_GATHER_TIMEOUT_MS,
  NOISE_CHANNEL_LABEL,
  parseSessionDescription,
  sessionDescriptionPayload,
  SIGNAL_CHANNEL_LABEL,
  TEXT_CHANNEL_LABEL,
  waitForIceGathering,
} from "./transport/rtc-utils";

export {
  applyConnectionAnswer,
  attachLocalCallTracks,
  clearOrphanedCallIce,
  closeCallPeerConnection,
  closePeerConnection,
  closeTextTransport,
  createConnectionOffer,
  ensureCallPeerConnection,
  ensurePeerConnection,
  ensureTextTransport,
  flushOrphanedCallIce,
  flushPendingIce,
  flushPendingLocalIce,
  flushPendingMessages,
  getCallPeerConnection,
  getDataChannel,
  getPeerConnection,
  getTransportPeerIds,
  isPeerConnected,
  isTextChannelOpen,
  isTransportReady,
  recycleAllPeerConnections,
  removeCallTracks,
  sendTextMessage,
  setCallIceReady,
  setTextTransportPaused,
  stopCallMediaTracks as stopMediaTracks,
  subscribeTextChannelState,
  subscribeTransportState,
  syncCallRemoteTracks,
} from "./transport/peer-connection";

export {
  ensureConversationSignaling,
  isSignalingChannelOpen,
  publishSignalingMessage,
  publishSignalingBestEffort,
  registerSignalingRoutes,
  setSignalingLocalPeerId,
} from "./transport/signaling";
