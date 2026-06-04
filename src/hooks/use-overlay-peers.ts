import { useSyncExternalStore } from "react";

import * as api from "@/lib/tauri";

let overlayPeerCount = 0;
const listeners = new Set<() => void>();
let started = false;

function notify() {
  for (const fn of listeners) {
    fn();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!started) {
    started = true;
    void (async () => {
      await api.startNetwork();
      overlayPeerCount = await api.overlayPeerCount();
      notify();
    })();
    void api.onOverlayPeersChanged((count) => {
      overlayPeerCount = count;
      if (count > 0) {
        void api.flushOutbox();
      }
      notify();
    });
  }
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return overlayPeerCount;
}

export function useOverlayPeers(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
