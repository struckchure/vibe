import { handleOrphanIce, handlePeerIce, handleTextSignaling } from "./peer-connection";
import { ingestSignalingWire, registerSignalingRoutes } from "./signaling";
import { setTrackerWireHandler } from "./tracker-signaling";

setTrackerWireHandler((remotePeerId, conversationId, wire) => {
  ingestSignalingWire(remotePeerId, conversationId, wire);
});

registerSignalingRoutes({
  onText: handleTextSignaling,
  onIce: async (remotePeerId, conversationId, candidate) => {
    if (await handlePeerIce(remotePeerId, conversationId, candidate)) {
      return;
    }
    handleOrphanIce(conversationId, remotePeerId, candidate);
  },
});
