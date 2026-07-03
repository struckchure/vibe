import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { refreshAllConnections } from "@/lib/connection-keeper";

/** Re-announce on tracker/overlay when the app returns to the foreground. */
export function useAppLifecycle(): void {
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refreshAllConnections();
      }
    };

    document.addEventListener("visibilitychange", onVisible);

    let unlistenFocus: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          refreshAllConnections();
        }
      })
      .then((unlisten) => {
        unlistenFocus = unlisten;
      })
      .catch(() => {
        /* not running in Tauri shell */
      });

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      unlistenFocus?.();
    };
  }, []);
}
