/**
 * @internal Shared call signaling setup for voice/video chat hooks.
 */
import { useEffect } from "react";

import { useListContacts, useLocalPeerId } from "@/hooks/contacts";
import { setupCallSignaling } from "@/lib/calls";

let engineSubscribers = 0;

export function useCallEngine() {
  const listContactQuery = useListContacts();
  const localPeerIdQuery = useLocalPeerId();

  useEffect(() => {
    engineSubscribers += 1;
    if (engineSubscribers === 1 && localPeerIdQuery.data) {
      const list = (listContactQuery.data ?? []).map((c) => ({
        peerId: c.peerId,
        displayName: c.displayName,
        conversationId: c.conversationId,
      }));
      void setupCallSignaling(localPeerIdQuery.data, list);
    }

    return () => {
      engineSubscribers -= 1;
    };
  }, [listContactQuery.data, localPeerIdQuery.data]);
}
