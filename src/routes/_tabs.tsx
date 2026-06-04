import {
  Link,
  Outlet,
  createFileRoute,
  useLocation,
} from "@tanstack/react-router";
import { MessageSquareIcon, PhoneIcon, VideoIcon } from "lucide-react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/_tabs")({
  component: RouteComponent,
});

function RouteComponent() {
  const location = useLocation();

  return (
    <div className="flex h-full w-full flex-col">
      <Tabs value={location.pathname.replace("/", "")}>
        <TabsList className="w-full justify-between gap-2 border p-0">
          <Link className="w-full h-full" to="/">
            <TabsTrigger className="w-full h-full" value="">
              <MessageSquareIcon />
              Text
            </TabsTrigger>
          </Link>

          <Link className="w-full h-full" to="/voice">
            <TabsTrigger className="w-full h-full" value="voice">
              <PhoneIcon />
              Voice
            </TabsTrigger>
          </Link>

          <Link className="w-full h-full" to="/video">
            <TabsTrigger className="w-full h-full" value="video">
              <VideoIcon />
              Video
            </TabsTrigger>
          </Link>
        </TabsList>
      </Tabs>

      <section className="flex min-h-0 flex-1 flex-col p-0">
        <Outlet />
      </section>
    </div>
  );
}
