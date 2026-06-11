import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

type ProcessLike = {
  env: Record<string, string | undefined>;
  browser: boolean;
};

const g = globalThis as unknown as { process?: ProcessLike };
const proc = g.process ?? { env: {}, browser: true };
proc.browser = true;
g.process = proc;
