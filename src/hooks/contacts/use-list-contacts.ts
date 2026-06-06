import { useQuery } from "@tanstack/react-query";

import { contactKeys } from "@/lib/query-keys";
import * as api from "@/lib/tauri";

/** `useQuery` for {@link contactKeys.all}. Use `.data`, `.isLoading`, `.refetch`, etc. */
export function useListContacts() {
  return useQuery({
    queryKey: contactKeys.all,
    queryFn: async () => await api.listContacts(),
  });
}
