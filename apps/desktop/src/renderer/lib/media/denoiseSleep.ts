/**
 * RNNoise on demand (docs/14-energy.md). The mic is captured all the time (AEC3 needs a continuous
 * stream, echo rule 3), but denoising 100 frames/s is only needed while the result can be heard or
 * decides something:
 *
 *  - `on`   — the mic is on air (VAD gate open, PTT held or its release tail, a meter on screen):
 *             every frame is denoised, reports every 20 ms — exactly the old behaviour;
 *  - `auto` — VAD mode, gate closed: RNNoise runs while the raw level is near the gate threshold
 *             and sleeps after `sleepMs` below it (`wakeDb` = gate threshold − `marginDb`).
 *             The gate needs both level > threshold and RNNoise VAD, so a quiet frame can never
 *             open it: sleeping through quiet frames changes no gate decision. On wake the last
 *             `preRollFrames` raw frames go through RNNoise first (output dropped) so its recurrent
 *             state is warm for the first syllable;
 *  - `off`  — the mic can't go on air by itself (PTT released, explicitly muted): no RNNoise.
 *
 * While asleep the worklet reports the raw level every `sleepReportFrames` (100 ms) instead of every
 * 20 ms: the published track is disabled then (silence is sent), so nobody hears the difference, and
 * the main thread wakes 10×/s instead of 50×/s. Pure logic, shared by the worklet and the tests.
 */
export type DenoiseMode = 'on' | 'auto' | 'off';

/** Main thread → worklet control message. */
export interface DenoiseControl {
  type: 'denoise';
  mode: DenoiseMode;
  /** Raw input level (dBFS) that keeps / wakes RNNoise in `auto`. */
  wakeDb: number;
}

export const DENOISE_SLEEP = {
  /** RNNoise frame, 10 ms @ 48 kHz. */
  frameMs: 10,
  /** Quiet this long in `auto` → sleep. */
  sleepMs: 2000,
  /**
   * Wake this far below the gate threshold. The gate needs the *denoised* level above the
   * threshold, and RNNoise only removes energy, so a raw frame below the threshold can't open it;
   * the margin covers rounding and the report's 20 ms averaging. Kept small on purpose: capture
   * AGC lifts a quiet room's noise floor to ≈ −58 dBFS, and a 10 dB margin (−60 at the default
   * −50 threshold) kept RNNoise awake forever (measured, docs/14-energy.md).
   */
  marginDb: 3,
  /** Raw frames replayed through RNNoise on wake (recurrent state warm-up), 50 ms. */
  preRollFrames: 5,
  /** Report interval while asleep, in 10 ms frames (100 ms). Awake: 2 frames (20 ms). */
  sleepReportFrames: 10,
} as const;

/** `auto`'s wake level for a gate threshold (docs/02 «Режимы микрофона»). */
export function wakeDbFor(thresholdDb: number): number {
  return thresholdDb - DENOISE_SLEEP.marginDb;
}

/**
 * The mode for the current transmit state. `onAir`: the track is enabled (gate open / PTT held /
 * release tail); `meter`: a live level meter is on screen (Settings → Голос) and wants the
 * denoised level at full rate.
 */
export function denoiseMode(i: { onAir: boolean; meter: boolean; micMode: 'voice' | 'ptt'; muted: boolean }): DenoiseMode {
  if (i.onAir || i.meter) return 'on';
  if (i.micMode === 'voice' && !i.muted) return 'auto';
  return 'off';
}

/** What to do with one 10 ms frame. `wake`: run the pre-roll, then denoise this frame. */
export type FrameAction = 'run' | 'wake' | 'sleep';

export class DenoiseScheduler {
  private mode: DenoiseMode = 'on';
  private wakeDb = -Infinity;
  private quietMs = 0;
  private awake = true;

  constructor(private readonly cfg: typeof DENOISE_SLEEP = DENOISE_SLEEP) {}

  control(c: Pick<DenoiseControl, 'mode' | 'wakeDb'>): void {
    // Entering `auto` starts awake with the full tail: the mic just left the air (or joined).
    if (c.mode === 'auto' && this.mode !== 'auto') this.quietMs = 0;
    this.mode = c.mode;
    this.wakeDb = c.wakeDb;
  }

  get asleep(): boolean {
    return !this.awake;
  }

  /** One frame, with its raw (pre-denoise) level in dBFS. */
  step(rawDb: number): FrameAction {
    let want: boolean;
    if (this.mode === 'on') want = true;
    else if (this.mode === 'off') want = false;
    else {
      if (rawDb >= this.wakeDb) this.quietMs = 0;
      else this.quietMs += this.cfg.frameMs;
      want = this.quietMs < this.cfg.sleepMs;
    }
    const was = this.awake;
    this.awake = want;
    if (!want) return 'sleep';
    return was ? 'run' : 'wake';
  }
}

/** dBFS of a linear RMS (−160 for digital silence). */
export function rmsDb(rms: number): number {
  return rms > 1e-8 ? 20 * Math.log10(rms) : -160;
}
