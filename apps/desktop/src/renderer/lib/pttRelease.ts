/**
 * Push-to-talk release tail (docs/02-media.md, «Push-to-talk»): after the key goes up the mic
 * stays on air for `pttReleaseMs` more (Discord's «PTT release delay», default 20 ms), so the
 * end of the last word is not clipped. A press inside the window cancels the pending release —
 * the gate never closes, so there is no click and nothing is re-signalled. Toggle-off, a gate
 * reset (binding changed, sleep) and mute / deafen / leave are immediate. Pure timer logic, no
 * React / LiveKit.
 */

/** Slider stops (ms): fine near zero, where the difference is audible, coarse up to 2 s. */
export const PTT_RELEASE_STEPS_MS = [0, 20, 50, 100, 250, 500, 750, 1000, 1250, 1500, 1750, 2000] as const;
export const PTT_RELEASE_DEFAULT_MS = 20;
export const PTT_RELEASE_MAX_MS = 2000;

/** A stored value → a sane delay (bad input → the default, out of range → clamped). */
export function releaseMs(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return PTT_RELEASE_DEFAULT_MS;
  return Math.max(0, Math.min(PTT_RELEASE_MAX_MS, Math.round(v)));
}

/** Index of the slider stop nearest to `ms`. */
export function releaseStep(ms: number): number {
  let best = 0;
  PTT_RELEASE_STEPS_MS.forEach((s, i) => {
    if (Math.abs(s - ms) < Math.abs((PTT_RELEASE_STEPS_MS[best] ?? 0) - ms)) best = i;
  });
  return best;
}

export interface ReleaseTimers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

const windowTimers: ReleaseTimers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

export class PttRelease {
  private on = false;
  private timer: number | null = null;

  constructor(
    /** Called on every real on/off transition, synchronously for a press and an immediate stop. */
    private readonly onChange: (talking: boolean) => void,
    private readonly timers: ReleaseTimers = windowTimers,
  ) {}

  get talking(): boolean {
    return this.on;
  }

  /** A release is scheduled (the key is up, the mic still on air). */
  get pending(): boolean {
    return this.timer !== null;
  }

  /** Key down: on at once; inside a release window just cancel the release (no transition). */
  press(): void {
    this.cancel();
    this.set(true);
  }

  /** Key up (hold mode): off after `delayMs`; 0 = now. */
  release(delayMs: number): void {
    this.cancel();
    if (!this.on) return;
    const ms = releaseMs(delayMs);
    if (ms <= 0) {
      this.set(false);
      return;
    }
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.set(false);
    }, ms);
  }

  /** Off now, no tail: toggle-off, gate reset, sleep, mute / deafen / leave. */
  stop(): void {
    this.cancel();
    this.set(false);
  }

  private cancel(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }

  private set(v: boolean): void {
    if (v === this.on) return;
    this.on = v;
    this.onChange(v);
  }
}
