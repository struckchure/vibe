import { useSyncExternalStore } from "react";

import type { Contact } from "@/lib/tauri";
import {
  getKeeperContactState,
  MAX_CONNECTING_RETRIES,
  subscribeConnectionKeeper,
  type KeeperContactState,
  type KeeperPhase,
} from "@/lib/connection-keeper";

export type AutoConnectPhase = KeeperPhase;
export type AutoConnectState = KeeperContactState;

export { MAX_CONNECTING_RETRIES };

export function useAutoConnect(
  contact: Contact | undefined,
  _localPeerId: string | undefined,
): AutoConnectState {
  return useSyncExternalStore(
    subscribeConnectionKeeper,
    () => getKeeperContactState(contact?.conversationId),
    () => ({ phase: "idle", retryAttempt: 1, maxRetries: MAX_CONNECTING_RETRIES }),
  );
}
