import { handleCallIce } from "./call-peer";
import { registerSignalingRoutes } from "./signaling";
import {
  handleOrphanIce,
  handleTextIce,
  handleTextSignaling,
} from "./text-peer";

registerSignalingRoutes({
  onText: handleTextSignaling,
  onIce: async (remotePeerId, conversationId, candidate) => {
    if (await handleCallIce(remotePeerId, conversationId, candidate)) {
      return;
    }
    if (await handleTextIce(remotePeerId, conversationId, candidate)) {
      return;
    }
    handleOrphanIce(conversationId, remotePeerId, candidate);
  },
});
