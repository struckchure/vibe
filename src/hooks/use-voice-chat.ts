import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useCallEngine } from "@/hooks/use-call-engine";
import type { ContactRef } from "@/types/contact";
import type { CallMedia } from "@/types/call";
import * as api from "@/lib/tauri";
import {
  acceptCall,
  declineCall,
  endCall,
  getCallSnapshot,
  type IncomingCall,
  isCallBusy,
  startCall,
  subscribeCallState,
  toggleCamera,
  toggleMute,
} from "@/lib/calls";

export type UseVoiceChatProps = {
  /** Called when an incoming audio call invite arrives. */
  onIncoming?: (pending: IncomingCall) => void | Promise<void>;
  /** Called when a call action throws. */
  onError?: (err: Error) => void | Promise<void>;
};

export type UseVideoChatProps = UseVoiceChatProps;

export type UseVoiceChatStartProps = { contact: ContactRef };
export type UseVideoChatStartProps = { contact: ContactRef };

function useCallChat(props: UseVoiceChatProps | undefined, media: CallMedia) {
  useCallEngine();

  const snapshot = useSyncExternalStore(
    subscribeCallState,
    getCallSnapshot,
    getCallSnapshot
  );
  const [accepting, setAccepting] = useState(false);
  const prevIncomingRef = useRef<IncomingCall | null>(null);
  const onIncoming = props?.onIncoming;
  const onError = props?.onError;

  const pendingIncoming =
    snapshot.pendingIncoming?.media === media ? snapshot.pendingIncoming : null;
  const active = snapshot.active?.media === media ? snapshot.active : null;

  useEffect(() => {
    if (!pendingIncoming || pendingIncoming === prevIncomingRef.current) {
      return;
    }
    prevIncomingRef.current = pendingIncoming;
    void onIncoming?.(pendingIncoming);
  }, [pendingIncoming, onIncoming]);

  const handleError = useCallback(
    async (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      await onError?.(error);
      throw error;
    },
    [onError]
  );

  const start = useCallback(
    async (startProps: UseVoiceChatStartProps) => {
      try {
        if (isCallBusy()) {
          throw new Error("Already in a call");
        }
        const localId = await api.getPeerId();
        await startCall(
          localId,
          {
            peerId: startProps.contact.peerId,
            displayName: startProps.contact.displayName,
            conversationId: startProps.contact.conversationId,
          },
          media
        );
      } catch (err) {
        await handleError(err);
      }
    },
    [handleError, media]
  );

  const accept = useCallback(async () => {
    if (accepting) {
      return;
    }
    setAccepting(true);
    try {
      const localId = await api.getPeerId();
      await acceptCall(localId);
    } catch (err) {
      await handleError(err);
    } finally {
      setAccepting(false);
    }
  }, [accepting, handleError]);

  const decline = useCallback(async () => {
    try {
      await declineCall();
    } catch (err) {
      await handleError(err);
    }
  }, [handleError]);

  const end = useCallback(async () => {
    try {
      await endCall();
    } catch (err) {
      await handleError(err);
    }
  }, [handleError]);

  return {
    active,
    pendingIncoming,
    localStream: snapshot.localStream,
    remoteStream: snapshot.remoteStream,
    isBusy: isCallBusy(),
    accepting,
    start,
    accept,
    decline,
    end,
    toggleMute,
    toggleCamera: media === "video" ? toggleCamera : undefined,
  };
}

/** Voice (audio-only) call session hook. */
export function useVoiceChat(props?: UseVoiceChatProps) {
  const result = useCallChat(props, "audio");
  const { toggleCamera: _toggleCamera, ...voice } = result;
  return voice;
}

/** Video call session hook. */
export function useVideoChat(props?: UseVideoChatProps) {
  return useCallChat(props, "video");
}
