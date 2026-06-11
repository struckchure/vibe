import { useEffect, useState, useSyncExternalStore } from "react";

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
      notify();
    });
  }
  return () => listeners.delete(listener);
}

function getCountSnapshot() {
  return overlayPeerCount;
}

export function useOverlayPeers(): number {
  return useSyncExternalStore(subscribe, getCountSnapshot, () => 0);
}

export function useContactOverlayConnected(peerId: string | undefined): boolean {
  const overlayCount = useOverlayPeers();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!peerId || overlayCount === 0) {
      setConnected(false);
      return;
    }
    let cancelled = false;
    void api.isOverlayPeerConnected(peerId).then((next) => {
      if (!cancelled) {
        setConnected(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [peerId, overlayCount]);

  return connected;
}
