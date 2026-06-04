import { MicIcon, MicOffIcon, PhoneOffIcon, VideoIcon, VideoOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CallControlsProps = {
  media: "audio" | "video";
  muted: boolean;
  cameraOff: boolean;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onEnd: () => void;
  className?: string;
};

export function CallControls({
  media,
  muted,
  cameraOff,
  onToggleMute,
  onToggleCamera,
  onEnd,
  className,
}: CallControlsProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-4",
        className
      )}
    >
      <Button
        variant="secondary"
        size="icon"
        className="size-12 rounded-full"
        onClick={onToggleMute}
        aria-label={muted ? "Unmute" : "Mute"}
      >
        {muted ? (
          <MicOffIcon className="size-5" />
        ) : (
          <MicIcon className="size-5" />
        )}
      </Button>
      {media === "video" ? (
        <Button
          variant="secondary"
          size="icon"
          className="size-12 rounded-full"
          onClick={onToggleCamera}
          aria-label={cameraOff ? "Turn camera on" : "Turn camera off"}
        >
          {cameraOff ? (
            <VideoOffIcon className="size-5" />
          ) : (
            <VideoIcon className="size-5" />
          )}
        </Button>
      ) : null}
      <Button
        variant="destructive"
        size="icon"
        className="size-14 rounded-full"
        onClick={onEnd}
        aria-label="End call"
      >
        <PhoneOffIcon className="size-6" />
      </Button>
    </div>
  );
}
