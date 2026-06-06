/**
 * @internal Shared call signaling setup for voice/video chat hooks.
 */
import { useEffect } from "react";

import { useListContacts, useLocalPeerId } from "@/hooks/contacts";
import * as api from "@/lib/tauri";
import { setupCallSignaling } from "@/lib/calls";

export function useCallEngine() {
  const contacts = useListContacts();
  const localPeerId = useLocalPeerId();

  useEffect(() => {
    async function setup() {
      if (!localPeerId.data) {
        return;
      }
      await api.startNetwork();
      const list = (contacts.data ?? []).map((c) => ({
        peerId: c.peerId,
        displayName: c.displayName,
        conversationId: c.conversationId,
      }));
      await setupCallSignaling(localPeerId.data, list);
    }
    void setup();
  }, [contacts.data, localPeerId.data]);
}
