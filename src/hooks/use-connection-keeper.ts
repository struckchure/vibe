import { useEffect, useSyncExternalStore } from "react";

import { useListContacts, useLocalPeerId } from "@/hooks/contacts";
import {
  getKeeperContactState,
  subscribeConnectionKeeper,
  syncConnectionKeeper,
  type KeeperPhase,
} from "@/lib/connection-keeper";

/** App-scoped keeper: announce and connect all contacts while the app runs. */
export function useConnectionKeeper(): void {
  const localPeerIdQuery = useLocalPeerId();
  const listContactQuery = useListContacts();

  useEffect(() => {
    syncConnectionKeeper(localPeerIdQuery.data, listContactQuery.data);
  }, [localPeerIdQuery.data, listContactQuery.data]);
}

export function useKeeperContactPhase(
  conversationId: string | undefined,
): KeeperPhase {
  return useSyncExternalStore(
    subscribeConnectionKeeper,
    () => getKeeperContactState(conversationId).phase,
    () => "idle",
  );
}
