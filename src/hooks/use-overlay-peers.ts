import { useEffect, useState, useSyncExternalStore } from "react";

import * as api from "@/lib/tauri";

let overlayPeerCount = 0;
const connectedPeers = new Set<string>();
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
      if (count === 0) {
        connectedPeers.clear();
      }
      notify();
    });
    void api.onOverlayPeerConnected((peerId) => {
      connectedPeers.add(peerId);
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
  const [connected, setConnected] = useState(
    () => (peerId ? connectedPeers.has(peerId) : false),
  );

  useEffect(() => {
    if (!peerId) {
      setConnected(false);
      return;
    }

    if (connectedPeers.has(peerId)) {
      setConnected(true);
      return;
    }

    let cancelled = false;
    const poll = () => {
      void api.isOverlayPeerConnected(peerId).then((next) => {
        if (!cancelled) {
          if (next) {
            connectedPeers.add(peerId);
          } else {
            connectedPeers.delete(peerId);
          }
          setConnected(next);
        }
      });
    };

    poll();
    const interval =
      overlayCount > 0 ? setInterval(poll, 2000) : undefined;

    const pending = api.onOverlayPeerConnected((id) => {
      if (id === peerId) {
        connectedPeers.add(peerId);
        setConnected(true);
      }
    });

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      void pending.then((unlisten) => unlisten());
    };
  }, [peerId, overlayCount]);

  return connected;
}
