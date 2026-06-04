import { PhoneIcon, PhoneOffIcon, VideoIcon } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CallMedia } from "@/types/call";

type IncomingCallDialogProps = {
  open: boolean;
  displayName: string;
  media: CallMedia;
  onAccept: () => void;
  onDecline: () => void;
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function IncomingCallDialog({
  open,
  displayName,
  media,
  onAccept,
  onDecline,
}: IncomingCallDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && open) {
          onDecline();
        }
      }}
    >
      <DialogContent className="z-[200] max-w-sm">
        <DialogHeader className="items-center text-center">
          <Avatar className="size-20">
            <AvatarFallback className="text-lg">
              {initials(displayName)}
            </AvatarFallback>
          </Avatar>
          <DialogTitle>{displayName}</DialogTitle>
          <DialogDescription>
            Incoming {media === "video" ? "video" : "voice"} call
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-center gap-6 pt-2">
          <Button
            variant="destructive"
            size="icon"
            className="size-14 rounded-full"
            onClick={onDecline}
            aria-label="Decline"
          >
            <PhoneOffIcon className="size-6" />
          </Button>
          <Button
            size="icon"
            className="size-14 rounded-full"
            onClick={onAccept}
            aria-label="Accept"
          >
            {media === "video" ? (
              <VideoIcon className="size-6" />
            ) : (
              <PhoneIcon className="size-6" />
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
