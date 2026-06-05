import { useEffect, useRef } from "react";

import { useTick } from "@/hooks/use-tick";

import { CallControls } from "@/components/call/call-controls";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { ActiveCall } from "@/types/call";

type CallOverlayProps = {
  call: ActiveCall;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onEnd: () => void;
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatDuration(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function phaseLabel(phase: ActiveCall["phase"]) {
  switch (phase) {
    case "outgoing":
      return "Calling…";
    case "incoming":
      return "Incoming…";
    case "connecting":
      return "Connecting…";
    case "active":
      return null;
    default:
      return null;
  }
}

function VideoEl({
  stream,
  muted,
  mirror,
  className,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  mirror?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!stream) {
      el.srcObject = null;
      return;
    }
    if (el.srcObject === stream) {
      return;
    }
    el.srcObject = stream;
    void el.play().catch(() => {});
  }, [stream]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={cn(mirror && "scale-x-[-1]", className)}
    />
  );
}

export function CallOverlay({
  call,
  localStream,
  remoteStream,
  onToggleMute,
  onToggleCamera,
  onEnd,
}: CallOverlayProps) {
  const ticking = call.phase === "active" && call.startedAt != null;
  const now = useTick(ticking);
  const elapsed = ticking && call.startedAt ? now - call.startedAt : 0;
  const audioTrack = localStream?.getAudioTracks()[0];
  const videoTrack = localStream?.getVideoTracks()[0];
  const muted = audioTrack ? !audioTrack.enabled : false;
  const cameraOff = videoTrack ? !videoTrack.enabled : false;

  const status = phaseLabel(call.phase);
  const remoteHasVideo =
    remoteStream?.getVideoTracks().some((t) => t.readyState !== "ended") ??
    false;
  const showRemoteVideo =
    call.media === "video" || remoteHasVideo;
  const remoteHasAudio =
    remoteStream?.getAudioTracks().some((t) => t.readyState !== "ended") ??
    false;
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = remoteAudioRef.current;
    if (!el) return;
    if (!remoteStream || !remoteHasAudio) {
      el.srcObject = null;
      return;
    }
    if (el.srcObject === remoteStream) {
      return;
    }
    el.srcObject = remoteStream;
    void el.play().catch(() => {});
  }, [remoteStream, remoteHasAudio]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {remoteHasAudio ? (
        <audio
          ref={remoteAudioRef}
          autoPlay
          playsInline
          className="sr-only"
          aria-hidden
        />
      ) : null}
      {showRemoteVideo && remoteStream ? (
        <VideoEl
          stream={remoteStream}
          muted
          className="absolute inset-0 size-full object-cover bg-black"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-muted/30">
          <Avatar className="size-28">
            <AvatarFallback className="text-3xl">
              {initials(call.displayName)}
            </AvatarFallback>
          </Avatar>
        </div>
      )}

      <div className="relative z-10 flex flex-1 flex-col">
        <header className="flex shrink-0 flex-col items-center gap-1 px-4 pt-8 text-center">
          <h2 className="text-lg font-medium text-foreground drop-shadow-sm">
            {call.displayName}
          </h2>
          <p className="text-sm text-muted-foreground">
            {status ??
              (call.phase === "active" && call.startedAt
                ? formatDuration(elapsed)
                : call.media === "video"
                  ? "Video call"
                  : "Voice call")}
          </p>
        </header>

        {call.media === "video" && localStream ? (
          <div className="pointer-events-none absolute right-4 top-24 size-28 overflow-hidden rounded-lg border-2 border-background shadow-lg">
            <VideoEl
              stream={localStream}
              muted
              mirror
              className="size-full object-cover"
            />
          </div>
        ) : null}

        <div className="mt-auto shrink-0 pb-10 pt-6">
          <CallControls
            media={call.media}
            muted={muted}
            cameraOff={cameraOff}
            onToggleMute={onToggleMute}
            onToggleCamera={onToggleCamera}
            onEnd={onEnd}
          />
        </div>
      </div>
    </div>
  );
}
