import {
  connectPayloadFromSdp,
  sdpPayloadFromConnect,
} from "@/lib/connect-handler";
import {
  buildConnectUri,
  isConnectUri,
  parseConnectUri,
} from "@/lib/connect-uri";
import { applyRemoteDescription, sessionDescriptionPayload, waitForIceGathering } from "@/lib/transport/rtc-utils";
import {
  applyConnectionAnswer,
  createConnectionOffer,
  ensurePeerConnection,
  type SdpExchangePayload,
} from "@/lib/transport/peer-connection";

export type { SdpExchangePayload };

/** Legacy JSON session blob (advanced fallback). */
export function serializeSdpExchange(payload: SdpExchangePayload): string {
  return JSON.stringify(payload);
}

export async function serializeConnectLink(
  payload: SdpExchangePayload,
  to?: string,
): Promise<string> {
  return buildConnectUri(connectPayloadFromSdp(payload, to));
}

export async function parseConnectLink(
  raw: string,
): Promise<SdpExchangePayload | null> {
  if (!isConnectUri(raw)) {
    return null;
  }
  const connect = await parseConnectUri(raw);
  return connect ? sdpPayloadFromConnect(connect) : null;
}

export function parseSdpExchange(raw: string): SdpExchangePayload | null {
  try {
    const parsed = JSON.parse(raw.trim()) as SdpExchangePayload;
    if (
      parsed?.v === 1 &&
      typeof parsed.peerId === "string" &&
      typeof parsed.conversationId === "string" &&
      (parsed.type === "offer" || parsed.type === "answer") &&
      parsed.sdp?.type &&
      parsed.sdp?.sdp
    ) {
      return parsed;
    }
  } catch {
    /* invalid */
  }
  return null;
}

export async function buildConnectionOffer(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string,
): Promise<SdpExchangePayload> {
  return createConnectionOffer(localPeerId, remotePeerId, conversationId);
}

export async function buildConnectionAnswer(
  localPeerId: string,
  remotePeerId: string,
  conversationId: string,
  offerPayload: SdpExchangePayload,
): Promise<SdpExchangePayload> {
  const peer = await ensurePeerConnection(
    localPeerId,
    remotePeerId,
    conversationId,
  );
  await applyRemoteDescription(peer.pc, offerPayload.sdp);
  const answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);
  await waitForIceGathering(peer.pc);
  const sdp = sessionDescriptionPayload(peer.pc.localDescription) ?? answer;
  return {
    v: 1,
    peerId: localPeerId,
    conversationId,
    type: "answer",
    sdp,
  };
}

export async function completeConnectionAnswer(
  remotePeerId: string,
  answerPayload: SdpExchangePayload,
): Promise<void> {
  await applyConnectionAnswer(remotePeerId, answerPayload);
}
