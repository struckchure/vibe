import { handleOrphanIce, handlePeerIce, handleTextSignaling } from "./peer-connection";
import { registerSignalingRoutes } from "./signaling";

registerSignalingRoutes({
  onText: handleTextSignaling,
  onIce: async (remotePeerId, conversationId, candidate) => {
    if (await handlePeerIce(remotePeerId, conversationId, candidate)) {
      return;
    }
    handleOrphanIce(conversationId, remotePeerId, candidate);
  },
});
