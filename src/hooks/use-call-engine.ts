/**
 * @internal Shared call signaling setup for voice/video chat hooks.
 */
import { useEffect } from "react";

import { useListContacts, useLocalPeerId } from "@/hooks/contacts";
import * as api from "@/lib/tauri";
import { setupCallSignaling } from "@/lib/calls";

export function useCallEngine() {
  const listContactQuery = useListContacts();
  const localPeerIdQuery = useLocalPeerId();

  useEffect(() => {
    async function setup() {
      if (!localPeerIdQuery.data) {
        return;
      }
      await api.startNetwork();
      const list = (listContactQuery.data ?? []).map((c) => ({
        peerId: c.peerId,
        displayName: c.displayName,
        conversationId: c.conversationId,
      }));
      await setupCallSignaling(localPeerIdQuery.data, list);
    }
    void setup();
  }, [listContactQuery.data, localPeerIdQuery.data]);
}
