declare module "bittorrent-tracker" {
  import type { EventEmitter } from "events";

  export type TrackerPeer = EventEmitter & {
    id?: string;
    send: (data: string | Uint8Array) => void;
    destroy: () => void;
    signal: (data: unknown) => void;
    on(event: "connect", listener: () => void): this;
    on(event: "data", listener: (data: string | Uint8Array) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
  };

  export type TrackerClientOptions = {
    infoHash: string;
    peerId: string;
    announce: string | string[];
    rtcConfig?: RTCConfiguration;
    port?: number;
  };

  export { TrackerPeer };

  export default class Client extends EventEmitter {
    constructor(opts: TrackerClientOptions);
    start(opts?: object): void;
    stop(opts?: object): void;
    destroy(cb?: () => void): void;
    on(event: "peer", listener: (peer: TrackerPeer) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "warning", listener: (err: Error) => void): this;
  }
}
