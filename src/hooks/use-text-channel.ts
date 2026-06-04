import { useCallback, useSyncExternalStore } from "react";

import { isTextChannelOpen, subscribeTextChannelState } from "@/lib/webrtc";

export function useTextChannelOpen(peerId: string | null): boolean {
  const getSnapshot = useCallback(
    () => (peerId ? isTextChannelOpen(peerId) : false),
    [peerId]
  );
  return useSyncExternalStore(
    subscribeTextChannelState,
    getSnapshot,
    () => false
  );
}
