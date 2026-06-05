import { useEffect } from "react";

import { CallOverlay } from "@/components/call/call-overlay";
import { IncomingCallDialog } from "@/components/call/incoming-call-dialog";
import { useCallContext } from "@/contexts/call-context";
import { stopIncomingRingtone } from "@/lib/call-ringtone";

/** Global incoming/active call UI — mounted at app root so iOS always shows invites. */
export function CallShell() {
  const call = useCallContext();

  const showCallOverlay =
    call.active &&
    call.active.phase !== "incoming" &&
    call.active.phase !== "idle" &&
    call.active.phase !== "ended";

  const showIncoming =
    call.active?.phase === "incoming" && call.pendingIncoming;

  useEffect(() => {
    if (!showIncoming) {
      stopIncomingRingtone();
    }
  }, [showIncoming]);

  return (
    <>
      <IncomingCallDialog
        open={!!showIncoming}
        displayName={call.pendingIncoming?.displayName ?? ""}
        media={call.pendingIncoming?.media ?? "audio"}
        accepting={call.accepting}
        onAccept={() => void call.acceptCall()}
        onDecline={() => void call.declineCall()}
      />

      {showCallOverlay && call.active ? (
        <CallOverlay
          call={call.active}
          localStream={call.localStream}
          remoteStream={call.remoteStream}
          onToggleMute={call.toggleMute}
          onToggleCamera={call.toggleCamera}
          onEnd={() => void call.endCall()}
        />
      ) : null}
    </>
  );
}
