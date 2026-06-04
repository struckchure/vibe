/** Incoming-call ring via Web Audio (no asset file). */

const RING_FREQ_A = 440;
const RING_FREQ_B = 480;
const BURST_DURATION_S = 0.4;
const BURST_GAP_S = 0.25;
const CYCLE_MS = 2800;
const GAIN_PEAK = 0.18;

let audioCtx: AudioContext | null = null;
let unlockListenersAttached = false;
let ringing = false;
let cycleTimer: ReturnType<typeof setTimeout> | null = null;

function attachUnlockListeners() {
  if (unlockListenersAttached || typeof window === "undefined") return;
  unlockListenersAttached = true;
  const unlock = () => {
    void audioCtx?.resume();
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock, { passive: true });
}

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctx =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
    attachUnlockListeners();
  }
  return audioCtx;
}

function playBurst(ctx: AudioContext, startAt: number) {
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(GAIN_PEAK, startAt + 0.02);
  gain.gain.setValueAtTime(GAIN_PEAK, startAt + BURST_DURATION_S - 0.05);
  gain.gain.linearRampToValueAtTime(0, startAt + BURST_DURATION_S);

  for (const freq of [RING_FREQ_A, RING_FREQ_B]) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(startAt);
    osc.stop(startAt + BURST_DURATION_S);
  }
}

function playRingCycle(ctx: AudioContext) {
  const t0 = ctx.currentTime;
  playBurst(ctx, t0);
  playBurst(ctx, t0 + BURST_DURATION_S + BURST_GAP_S);
}

function scheduleNextCycle() {
  cycleTimer = setTimeout(() => {
    cycleTimer = null;
    if (!ringing) return;
    const ctx = getAudioContext();
    if (!ctx) return;
    void ctx.resume().then(() => {
      if (!ringing) return;
      playRingCycle(ctx);
      scheduleNextCycle();
    });
  }, CYCLE_MS);
}

export function startIncomingRingtone() {
  if (ringing) return;
  ringing = true;
  const ctx = getAudioContext();
  if (!ctx) return;
  void ctx.resume().then(() => {
    if (!ringing) return;
    playRingCycle(ctx);
    scheduleNextCycle();
  });
}

export function stopIncomingRingtone() {
  ringing = false;
  if (cycleTimer != null) {
    clearTimeout(cycleTimer);
    cycleTimer = null;
  }
}
