import { createRootRoute, Outlet } from "@tanstack/react-router";
import { platform } from "@tauri-apps/plugin-os";
import { QueryClientProvider } from "@tanstack/react-query";

import { cn } from "@/lib/utils";
import { createQueryClient } from "@/lib/query-client";
import { AppProviders } from "@/providers/app-providers";
import appCss from "@/styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        name: "viewport",
        content:
          "width=device-width, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no viewport-fit=cover",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootLayout,
});

const queryClient = createQueryClient();

function RootLayout() {
  const currentPlatform = platform();

  return (
    <QueryClientProvider client={queryClient}>
      <main
        className={cn(
          "h-screen w-full",
          ["android", "ios"].includes(currentPlatform) && "h-[95vh] mt-auto",
        )}
      >
        <AppProviders>
          <Outlet />
        </AppProviders>
      </main>
    </QueryClientProvider>
  );
}
