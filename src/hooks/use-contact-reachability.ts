import { useSyncExternalStore } from "react";

import {
  getTransportPeerIds,
  isTransportReady,
  subscribeTransportState,
} from "@/lib/webrtc";

let cachedSnapshot = new Set<string>();
let cachedKey = "";

function computeSnapshotKey(): string {
  const ids: string[] = [];
  for (const peerId of getTransportPeerIds()) {
    if (isTransportReady(peerId)) {
      ids.push(peerId);
    }
  }
  ids.sort();
  return ids.join("\0");
}

function getSnapshot(): Set<string> {
  const key = computeSnapshotKey();
  if (key === cachedKey) {
    return cachedSnapshot;
  }
  cachedKey = key;
  cachedSnapshot = new Set(key ? key.split("\0") : []);
  return cachedSnapshot;
}

function subscribe(listener: () => void) {
  return subscribeTransportState(listener);
}

export function useContactReachability(): Set<string> {
  return useSyncExternalStore(subscribe, getSnapshot, () => new Set());
}

export function useIsContactReachable(peerId: string | undefined): boolean {
  const reachable = useContactReachability();
  return peerId ? reachable.has(peerId) : false;
}
