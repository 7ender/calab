/**
 * Receive-side limits of annotations (ADR-0028): a token bucket per sender (30 messages/s,
 * burst 30) and a growing `seq` per sender. Everything over the limit is dropped silently.
 */
export const RECV_RATE = 30;
export const RECV_BURST = 30;
/** Sender side: one message per this many ms at most (pointer position / stroke batch). */
export const SEND_INTERVAL_MS = 50;

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rate = RECV_RATE,
    private readonly burst = RECV_BURST,
  ) {}

  /** One message from `key` at `now` (ms): true = within the limit. */
  take(key: string, now: number): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.rate);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    return ok;
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * `seq` grows by one per message of a sender in a call. Reliable delivery keeps order; this drops
 * duplicates and replays. A sender that rejoined starts again from 1 — accepted as a restart.
 */
export class SeqGuard {
  private readonly last = new Map<string, number>();

  accept(key: string, seq: number): boolean {
    const prev = this.last.get(key);
    if (seq <= 0) return false;
    if (prev !== undefined && seq <= prev && seq !== 1) return false;
    this.last.set(key, seq);
    return true;
  }

  forget(key: string): void {
    this.last.delete(key);
  }

  reset(): void {
    this.last.clear();
  }
}

/**
 * Sender-side thinning of a stroke: a point closer than `minDist` (normalized units) to the last
 * kept one adds nothing visible and only costs bytes.
 */
export const MIN_POINT_DIST = 0.002;

export function farEnough(last: readonly [number, number] | null, x: number, y: number, minDist = MIN_POINT_DIST): boolean {
  if (!last) return true;
  return Math.hypot(x - last[0], y - last[1]) >= minDist;
}
