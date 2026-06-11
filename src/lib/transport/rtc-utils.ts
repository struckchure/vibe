export const TEXT_CHANNEL_LABEL = "vibe/text";
export const SIGNAL_CHANNEL_LABEL = "vibe/signal";
export const NOISE_CHANNEL_LABEL = "vibe/noise";

export const CALL_ICE_GATHER_TIMEOUT_MS = 10_000;

export function isImpolite(localPeerId: string, remotePeerId: string): boolean {
  return localPeerId > remotePeerId;
}

export function sessionDescriptionPayload(
  desc: RTCSessionDescription | RTCSessionDescriptionInit | null | undefined
): RTCSessionDescriptionInit | null {
  if (!desc) return null;
  if (!desc.type || !desc.sdp) return null;
  return { type: desc.type, sdp: desc.sdp };
}

/** testclient sdpInit — accepts JSON-stringified SDP or raw SDP string. */
export function parseSessionDescription(
  sdp: RTCSessionDescriptionInit | string | null | undefined
): RTCSessionDescriptionInit | null {
  if (!sdp) return null;
  if (typeof sdp === "string") {
    try {
      const parsed = JSON.parse(sdp) as RTCSessionDescriptionInit;
      if (parsed?.type && parsed.sdp) {
        return { type: parsed.type, sdp: parsed.sdp };
      }
    } catch {
      return { type: "offer", sdp };
    }
    return null;
  }
  return sessionDescriptionPayload(sdp);
}

export async function applyRemoteDescription(
  pc: RTCPeerConnection,
  desc: RTCSessionDescriptionInit | string
) {
  const payload = parseSessionDescription(desc);
  if (!payload) {
    throw new Error("invalid session description");
  }
  await pc.setRemoteDescription(payload);
}

/** Wait until ICE gathering finishes so SDP includes connection candidates. */
export function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs = 8000
): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        done();
      }
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}
