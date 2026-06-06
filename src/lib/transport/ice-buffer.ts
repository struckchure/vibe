export class IceBuffer {
  private queue: RTCIceCandidateInit[] = [];

  enqueue(candidate: RTCIceCandidateInit) {
    this.queue.push(candidate);
  }

  drain(): RTCIceCandidateInit[] {
    if (this.queue.length === 0) return [];
    return this.queue.splice(0);
  }

  get length() {
    return this.queue.length;
  }
}

const orphanedIce = new Map<string, IceBuffer>();

export function orphanIceKey(conversationId: string, remotePeerId: string) {
  return `${conversationId}:${remotePeerId}`;
}

export function getOrphanIceBuffer(
  conversationId: string,
  remotePeerId: string
): IceBuffer {
  const key = orphanIceKey(conversationId, remotePeerId);
  let buffer = orphanedIce.get(key);
  if (!buffer) {
    buffer = new IceBuffer();
    orphanedIce.set(key, buffer);
  }
  return buffer;
}

export function clearOrphanIce(conversationId: string, remotePeerId: string) {
  orphanedIce.delete(orphanIceKey(conversationId, remotePeerId));
}

export async function flushIceToPeer(
  pc: RTCPeerConnection,
  buffer: IceBuffer
) {
  if (!pc.remoteDescription) return;
  for (const candidate of buffer.drain()) {
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      /* ignore late ICE */
    }
  }
}

export async function addIceCandidate(
  pc: RTCPeerConnection,
  buffer: IceBuffer,
  candidate: RTCIceCandidateInit
) {
  if (!pc.remoteDescription) {
    buffer.enqueue(candidate);
    return;
  }
  try {
    await pc.addIceCandidate(candidate);
  } catch {
    /* ignore late ICE */
  }
}
