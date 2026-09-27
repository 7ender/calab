/**
 * Speaking indicator (docs/08 «Индикация речи», docs/09 #15/#30): the ring around a speaker's
 * avatar and their brighter name. The ring appears at once (both sources already need speech to call
 * someone speaking) and stays 200 ms after the last speech, so short pauses between
 * words don't flicker. Store updates are coalesced (≤ one per `BATCH_MS`) and only emitted when
 * the set actually changed, so a busy call doesn't re-render the store's subscribers per event.
 * Pure timer logic, no React / LiveKit.
 */
export const SPEAKING_SHOW_MS = 0;
export const SPEAKING_HIDE_MS = 200;
export const SPEAKING_BATCH_MS = 50;

export interface Timers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

const NONE: ReadonlySet<string> = new Set();

const windowTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

/** LiveKit identity is `<user_id>:<session_id>` (rtc.proto). */
const userIdOfIdentity = (identity: string): string => identity.split(':')[0] ?? identity;

/**
 * Who speaks, by user id, from the two sources (one person may be in the room from several
 * devices — any of them speaking lights the person up once):
 *  - remote participants: LiveKit ActiveSpeakersChanged identities OR-ed with the local level of
 *    their incoming audio (lib/remoteSpeaking.ts), my own session excluded;
 *  - me: the local VAD gate / PTT (`transmitting`) — instant, not the server's round trip.
 */
export function speakingUserIds(remoteIdentities: Iterable<string>, localIdentity: string | null, me: { userId: string | null; on: boolean }): Set<string> {
  const out = new Set<string>();
  for (const identity of remoteIdentities) if (identity !== localIdentity) out.add(userIdOfIdentity(identity));
  if (me.on && me.userId) out.add(me.userId);
  return out;
}

export class SpeakingDebouncer {
  private shown = new Set<string>();
  private pending = new Map<string, { timer: number; to: boolean }>();
  private flushTimer: number | null = null;
  /** The last emitted set, as a sorted key (dedupes no-op emits). */
  private emitted = '';

  constructor(
    private readonly onChange: (speaking: Record<string, boolean>) => void,
    private readonly timers: Timers = windowTimers,
    private readonly showMs = SPEAKING_SHOW_MS,
    private readonly hideMs = SPEAKING_HIDE_MS,
    private readonly batchMs = SPEAKING_BATCH_MS,
  ) {}

  /**
   * The current raw set of active speakers (user ids). `instantOff`: ids whose «off» is exact and
   * must not linger (my own ring in push-to-talk: it follows the gate, the release tail is already
   * applied) — hidden and emitted at once, without the hide delay and the batch.
   */
  update(active: Iterable<string>, instantOff: ReadonlySet<string> = NONE): void {
    const now = new Set(active);
    for (const id of now) this.want(id, true);
    for (const id of this.shown) if (!now.has(id)) this.want(id, false, instantOff.has(id));
    // Pending "show" for someone who stopped before the delay elapsed: cancel.
    for (const [id, p] of this.pending) if (p.to && !now.has(id)) this.cancel(id);
  }

  /** Drop everything immediately (leaving the room). */
  reset(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
    if (this.flushTimer !== null) this.timers.clear(this.flushTimer);
    this.flushTimer = null;
    this.shown.clear();
    this.flush();
  }

  private want(id: string, on: boolean, instant = false): void {
    const isShown = this.shown.has(id);
    const p = this.pending.get(id);
    if (isShown === on) {
      // Already in the wanted state: a pending opposite transition is obsolete.
      if (p) this.cancel(id);
      return;
    }
    if (instant) {
      if (p) this.cancel(id);
      this.shown.delete(id);
      if (this.flushTimer !== null) this.timers.clear(this.flushTimer);
      this.flushTimer = null;
      this.flush();
      return;
    }
    if (p?.to === on) return; // already scheduled
    if (p) this.cancel(id);
    const delay = on ? this.showMs : this.hideMs;
    if (delay <= 0) {
      this.apply(id, on);
      return;
    }
    const timer = this.timers.set(() => {
      this.pending.delete(id);
      this.apply(id, on);
    }, delay);
    this.pending.set(id, { timer, to: on });
  }

  private apply(id: string, on: boolean): void {
    if (on) this.shown.add(id);
    else this.shown.delete(id);
    this.schedule();
  }

  private cancel(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.timers.clear(p.timer);
    this.pending.delete(id);
  }

  private schedule(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = this.timers.set(() => {
      this.flushTimer = null;
      this.flush();
    }, this.batchMs);
  }

  private flush(): void {
    const ids = [...this.shown].sort();
    const key = ids.join('\n');
    if (key === this.emitted) return;
    this.emitted = key;
    const out: Record<string, boolean> = {};
    for (const id of ids) out[id] = true;
    this.onChange(out);
  }
}
