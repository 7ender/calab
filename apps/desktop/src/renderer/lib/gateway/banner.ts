import type { GatewayStatus } from './client';

/** A drop shorter than this (a deploy re-IDENTIFY, a RECONNECT) never shows the banner. */
export const RECONNECT_BANNER_DELAY_MS = 3000;

export interface BannerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: BannerTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * «Нет соединения с сервером — переподключаемся…» decision, driven only by gateway status
 * transitions (pure: timers are injected).
 *
 * - Shown only after the gateway has been established (READY/RESUMED) and then stayed down
 *   (connecting / resuming / reconnecting) for longer than the delay; the first connect shows
 *   the full-screen spinner instead.
 * - Hidden at once on 'ready' (READY or RESUMED) and on 'idle'/'stopped' (logout, fatal: other
 *   screens take over).
 * - Every outage gets its own generation: a timer armed for an earlier outage can never show the
 *   banner for a later state, even if clearing it raced with its firing.
 */
export class ReconnectBanner {
  private visible = false;
  private established = false;
  private timer: unknown = null;
  private gen = 0;

  constructor(
    private readonly onChange: (visible: boolean) => void,
    private readonly timers: BannerTimers = realTimers,
    private readonly delayMs = RECONNECT_BANNER_DELAY_MS,
  ) {}

  get shown(): boolean {
    return this.visible;
  }

  update(status: GatewayStatus): void {
    switch (status) {
      case 'ready':
        this.established = true;
        this.cancel();
        this.set(false);
        return;
      case 'idle':
      case 'stopped':
        this.established = false;
        this.cancel();
        this.set(false);
        return;
      default:
        // Down. Measure from the first moment of this outage; intermediate transitions
        // (reconnecting → resuming → reconnecting) do not restart the clock.
        if (!this.established || this.visible || this.timer !== null) return;
        this.arm();
    }
  }

  /** Forget everything (a new gateway client / logout). */
  reset(): void {
    this.established = false;
    this.cancel();
    this.set(false);
  }

  private arm(): void {
    const gen = ++this.gen;
    this.timer = this.timers.setTimeout(() => {
      if (gen !== this.gen) return; // stale: that outage already ended
      this.timer = null;
      this.set(true);
    }, this.delayMs);
  }

  private cancel(): void {
    this.gen++;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private set(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    this.onChange(v);
  }
}
