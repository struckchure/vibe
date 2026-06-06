import { useQuery } from "@tanstack/react-query";

import { peerKeys } from "@/lib/query-keys";
import * as api from "@/lib/tauri";

/** `useQuery` for {@link peerKeys.local}. */
export function useLocalPeerId() {
  return useQuery({
    queryKey: peerKeys.local,
    queryFn: async () => await api.getPeerId(),
    staleTime: Infinity,
  });
}
