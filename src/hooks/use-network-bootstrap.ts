import { useEffect } from "react";

import * as api from "@/lib/tauri";

/** Start the libp2p overlay once on app open (idempotent). */
export function useNetworkBootstrap() {
  useEffect(() => {
    void api.startNetwork();
  }, []);
}
