import { formatConnectError } from "@/lib/connect-errors";
import type { ConnectPayload } from "@/lib/connect-uri";
import {
  buildConnectUri,
  isConnectUri,
  normalizeConnectInput,
  parseConnectUriDetailed,
} from "@/lib/connect-uri";
import { parseSdpExchange } from "@/lib/sdp-exchange";
import {
  buildConnectionAnswer,
  completeConnectionAnswer,
  type SdpExchangePayload,
} from "@/lib/sdp-exchange";
import * as api from "@/lib/tauri";
import { flushPendingMessages } from "@/lib/webrtc";

export type ProcessConnectResult =
  | {
      status: "answer_ready";
      answerUri: string;
      remotePeerId: string;
      remoteDisplayName: string;
      conversationId: string;
    }
  | {
      status: "connected";
      remotePeerId: string;
      conversationId: string;
    }
  | {
      status: "error";
      message: string;
    };

export function sdpPayloadFromConnect(connect: ConnectPayload): SdpExchangePayload {
  return {
    v: 1,
    peerId: connect.from,
    conversationId: connect.conversationId,
    type: connect.kind,
    sdp: connect.sdp,
  };
}

export function connectPayloadFromSdp(
  sdp: SdpExchangePayload,
  to?: string,
): ConnectPayload {
  return {
    v: 1,
    from: sdp.peerId,
    to,
    kind: sdp.type,
    conversationId: sdp.conversationId,
    sdp: sdp.sdp,
  };
}

async function ensureContact(
  remotePeerId: string,
  conversationId: string,
): Promise<string> {
  const contacts = await api.listContacts();
  const existing = contacts.find((c) => c.peerId === remotePeerId);
  if (existing) {
    return existing.displayName;
  }
  const row = await api.addContact(
    remotePeerId,
    `Contact ${remotePeerId.slice(0, 8)}`,
  );
  if (row.conversationId !== conversationId) {
    /* conversation id is deterministic from peer keys — trust payload */
  }
  return row.displayName;
}

export async function processConnectPayload(
  payload: ConnectPayload,
  localPeerId: string,
): Promise<ProcessConnectResult> {
  try {
    if (payload.kind === "offer") {
      if (payload.from === localPeerId) {
        return {
          status: "error",
          message: formatConnectError("Cannot apply your own offer link"),
        };
      }

      const displayName = await ensureContact(
        payload.from,
        payload.conversationId,
      );
      const offer = sdpPayloadFromConnect(payload);
      const answer = await buildConnectionAnswer(
        localPeerId,
        payload.from,
        payload.conversationId,
        offer,
      );
      const answerUri = await buildConnectUri(
        connectPayloadFromSdp(answer, payload.from),
      );

      return {
        status: "answer_ready",
        answerUri,
        remotePeerId: payload.from,
        remoteDisplayName: displayName,
        conversationId: payload.conversationId,
      };
    }

    if (payload.to && payload.to !== localPeerId) {
      return {
        status: "error",
        message: formatConnectError(
          "This answer link is intended for a different device",
        ),
      };
    }

    if (payload.from === localPeerId) {
      return {
        status: "error",
        message: formatConnectError("Cannot apply your own answer link"),
      };
    }

    await ensureContact(payload.from, payload.conversationId);
    const answer = sdpPayloadFromConnect(payload);
    await completeConnectionAnswer(payload.from, answer);
    await flushPendingMessages(payload.from);

    return {
      status: "connected",
      remotePeerId: payload.from,
      conversationId: payload.conversationId,
    };
  } catch (err) {
    return { status: "error", message: formatConnectError(err) };
  }
}

export async function processConnectInput(
  raw: string,
  localPeerId: string,
  contactPeerId?: string,
): Promise<ProcessConnectResult> {
  const trimmed = normalizeConnectInput(raw);
  if (!trimmed) {
    return { status: "error", message: "Paste a connect or answer link first." };
  }

  if (isConnectUri(trimmed)) {
    const parsed = await parseConnectUriDetailed(trimmed);
    if (!parsed.ok) {
      return { status: "error", message: parsed.error };
    }
    return processConnectPayload(parsed.payload, localPeerId);
  }

  const sdp = parseSdpExchange(trimmed);
  if (!sdp) {
    return {
      status: "error",
      message:
        "Invalid connect link or session JSON. Paste a vibe://connect link or valid session JSON.",
    };
  }

  return processConnectPayload(
    connectPayloadFromSdp(sdp, contactPeerId),
    localPeerId,
  );
}
