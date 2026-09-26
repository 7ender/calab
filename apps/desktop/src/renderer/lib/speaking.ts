/**
 * Speaking indicator hysteresis (docs/09 #15/#30): LiveKit ActiveSpeakersChanged flickers on
 * short pauses, so a participant is shown as speaking only after 100 ms of speech and stays
 * shown for 300 ms after the last speech. Pure timer logic, no React / LiveKit.
 */
export const SPEAKING_SHOW_MS = 100;
export const SPEAKING_HIDE_MS = 300;

export interface Timers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

const windowTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

export class SpeakingDebouncer {
  private shown = new Set<string>();
  private pending = new Map<string, { timer: number; to: boolean }>();

  constructor(
    private readonly onChange: (speaking: Record<string, boolean>) => void,
    private readonly timers: Timers = windowTimers,
    private readonly showMs = SPEAKING_SHOW_MS,
    private readonly hideMs = SPEAKING_HIDE_MS,
  ) {}

  /** The current raw set of active speakers (user ids). */
  update(active: Iterable<string>): void {
    const now = new Set(active);
    for (const id of now) this.want(id, true);
    for (const id of this.shown) if (!now.has(id)) this.want(id, false);
    // Pending "show" for someone who stopped before the delay elapsed: cancel.
    for (const [id, p] of this.pending) if (p.to && !now.has(id)) this.cancel(id);
  }

  /** Drop everything immediately (leaving the room). */
  reset(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
    if (this.shown.size) {
      this.shown.clear();
      this.emit();
    }
  }

  private want(id: string, on: boolean): void {
    const isShown = this.shown.has(id);
    const p = this.pending.get(id);
    if (isShown === on) {
      // Already in the wanted state: a pending opposite transition is obsolete.
      if (p) this.cancel(id);
      return;
    }
    if (p?.to === on) return; // already scheduled
    if (p) this.cancel(id);
    const timer = this.timers.set(
      () => {
        this.pending.delete(id);
        if (on) this.shown.add(id);
        else this.shown.delete(id);
        this.emit();
      },
      on ? this.showMs : this.hideMs,
    );
    this.pending.set(id, { timer, to: on });
  }

  private cancel(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.timers.clear(p.timer);
    this.pending.delete(id);
  }

  private emit(): void {
    const out: Record<string, boolean> = {};
    for (const id of this.shown) out[id] = true;
    this.onChange(out);
  }
}
