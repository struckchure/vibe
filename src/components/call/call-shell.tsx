import { useEffect } from "react";
import { startIncomingRingtone, stopIncomingRingtone } from "@/lib/call-ringtone";

import { CallOverlay } from "@/components/call/call-overlay";
import { IncomingCallDialog } from "@/components/call/incoming-call-dialog";
import { useVideoChat, useVoiceChat } from "@/hooks/use-voice-chat";

/** Global incoming/active call UI — mounted at app root so iOS always shows invites. */
export function CallShell() {
  const voice = useVoiceChat({
    onIncoming: () => {
      startIncomingRingtone();
    },
  });
  const video = useVideoChat({
    onIncoming: () => {
      startIncomingRingtone();
    },
  });

  const pendingIncoming = voice.pendingIncoming ?? video.pendingIncoming;
  const active = voice.active ?? video.active;
  const localStream = voice.localStream ?? video.localStream;
  const remoteStream = voice.remoteStream ?? video.remoteStream;
  const accepting = voice.accepting || video.accepting;

  const showCallOverlay =
    active &&
    active.phase !== "incoming" &&
    active.phase !== "idle" &&
    active.phase !== "ended";

  const showIncoming = active?.phase === "incoming" && pendingIncoming;

  useEffect(() => {
    if (!showIncoming) {
      stopIncomingRingtone();
    }
  }, [showIncoming]);

  const accept = pendingIncoming?.media === "video" ? video.accept : voice.accept;
  const decline = pendingIncoming?.media === "video" ? video.decline : voice.decline;
  const end = active?.media === "video" ? video.end : voice.end;
  const toggleMute = active?.media === "video" ? video.toggleMute : voice.toggleMute;
  const toggleCamera = video.toggleCamera;

  return (
    <>
      <IncomingCallDialog
        open={!!showIncoming}
        displayName={pendingIncoming?.displayName ?? ""}
        media={pendingIncoming?.media ?? "audio"}
        accepting={accepting}
        onAccept={accept}
        onDecline={decline}
      />

      {showCallOverlay && active && (
        <CallOverlay
          call={active}
          localStream={localStream}
          remoteStream={remoteStream}
          onToggleMute={toggleMute}
          onToggleCamera={toggleCamera ?? (() => {})}
          onEnd={end}
        />
      )}
    </>
  );
}
