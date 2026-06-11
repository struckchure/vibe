import * as api from "@/lib/tauri";

import { isImpolite } from "./rtc-utils";

type NoiseWireMessage = {
  step: 1 | 2 | 3;
  payload: string;
};

const handshakeInFlight = new Set<string>();

function sendNoiseStep(channel: RTCDataChannel, step: NoiseWireMessage["step"], payload: string) {
  const wire: NoiseWireMessage = { step, payload };
  channel.send(JSON.stringify(wire));
}

async function handleNoiseWire(
  localPeerId: string,
  remotePeerId: string,
  wire: NoiseWireMessage,
  channel: RTCDataChannel
) {
  if (wire.step === 1) {
    const { messageB64 } = await api.noiseHandshakeRespond(
      remotePeerId,
      wire.payload
    );
    sendNoiseStep(channel, 2, messageB64);
    return;
  }

  const impolite = isImpolite(localPeerId, remotePeerId);

  if (wire.step === 2 && impolite) {
    const { messageB64 } = await api.noiseHandshakeFinishInitiator(
      remotePeerId,
      wire.payload
    );
    sendNoiseStep(channel, 3, messageB64);
    return;
  }

  if (wire.step === 3 && !impolite) {
    await api.noiseHandshakeFinishResponder(remotePeerId, wire.payload);
  }
}

export function attachNoiseChannel(
  localPeerId: string,
  remotePeerId: string,
  channel: RTCDataChannel
) {
  channel.onmessage = (ev) => {
    const raw =
      typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
    let wire: NoiseWireMessage;
    try {
      wire = JSON.parse(raw) as NoiseWireMessage;
      if (!wire.step || !wire.payload) return;
    } catch {
      return;
    }
    void handleNoiseWire(localPeerId, remotePeerId, wire, channel).catch(() => {
      /* handshake failed — retry on next connect */
    });
  };
}

export async function bootstrapNoiseHandshake(
  localPeerId: string,
  remotePeerId: string,
  channel: RTCDataChannel
) {
  if (handshakeInFlight.has(remotePeerId)) {
    return;
  }
  if (await api.isNoiseReady(remotePeerId)) {
    return;
  }
  if (!isImpolite(localPeerId, remotePeerId)) {
    return;
  }
  if (channel.readyState !== "open") {
    return;
  }

  handshakeInFlight.add(remotePeerId);
  try {
    if (await api.isNoiseReady(remotePeerId)) {
      return;
    }
    const { messageB64 } = await api.noiseHandshakeStart(remotePeerId);
    sendNoiseStep(channel, 1, messageB64);
  } finally {
    handshakeInFlight.delete(remotePeerId);
  }
}

export function clearNoiseHandshake(remotePeerId: string) {
  handshakeInFlight.delete(remotePeerId);
}
