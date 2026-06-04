import { useSyncExternalStore } from "react";

/** Re-renders about once per second while enabled (no React setState). */
export function useTick(enabled: boolean): number {
  return useSyncExternalStore(
    (onStoreChange) => {
      if (!enabled) return () => {};
      const id = window.setInterval(onStoreChange, 1000);
      return () => window.clearInterval(id);
    },
    () => Date.now(),
    () => 0
  );
}
