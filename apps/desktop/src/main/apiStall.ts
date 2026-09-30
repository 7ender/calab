/**
 * When to throw away the API connections (docs/12 «спиннер чата», docs/09 #146).
 *
 * `calaba-api://` requests share one HTTP/2 connection to the server. If that connection wedges —
 * proven cause: its flow-control window eaten by response streams nobody reads, see apiProtocol.ts;
 * also a connection black-holed by sleep / a Wi-Fi roam — every request on it hangs while the
 * gateway WebSocket (its own connection) keeps working. The deadlines in apiProtocol.ts end each
 * such request; this policy decides from those timeouts that the transport, not one slow request,
 * is broken, and the caller closes every connection of the API session (a fresh one next time).
 *
 * Pure (no Electron, no timers): the caller feeds events with timestamps. Nothing runs when idle.
 */

export interface StallPolicy {
  /** Timeouts counted together within this window… */
  windowMs: number;
  /** …this many of them mean a broken transport. */
  timeouts: number;
  /** A timeout while another request has waited this long for its response headers also does. */
  stuckMs: number;
  /** At most one timeout-driven reset per this long. */
  cooldownMs: number;
  /** A wake / network event right after a reset does not repeat it. */
  wakeCooldownMs: number;
}

export const DEFAULT_STALL_POLICY: StallPolicy = {
  windowMs: 60_000,
  timeouts: 2,
  stuckMs: 5_000,
  cooldownMs: 30_000,
  wakeCooldownMs: 5_000,
};

export type WakeEvent = 'resume' | 'unlock-screen' | 'online';

export class StallDetector {
  private readonly policy: StallPolicy;
  private readonly now: () => number;
  /** Request id → when it started or last sent a request-body chunk; only requests still waiting
   * for their response headers and not slow by design (see started). */
  private readonly waiting = new Map<number, number>();
  private recent: number[] = [];
  /** Last chunk moved by any request or response (an upload / download in progress). */
  private lastProgress = Number.NEGATIVE_INFINITY;
  private lastReset = Number.NEGATIVE_INFINITY;
  private seq = 0;

  constructor(now: () => number = Date.now, policy: Partial<StallPolicy> = {}) {
    this.now = now;
    this.policy = { ...DEFAULT_STALL_POLICY, ...policy };
  }

  /**
   * A request is sent; returns its id for the calls below. `patient`: the server answers it only
   * after a long wait by design (the SIP test) — its long wait is no evidence against the others.
   */
  started(patient = false): number {
    const id = ++this.seq;
    if (!patient) this.waiting.set(id, this.now());
    return id;
  }

  /**
   * A body chunk moved (request upload or response download). A request still sending its body
   * is not stuck; and while bytes move, a wake does not close the connections under them.
   */
  progress(id?: number): void {
    const t = this.now();
    this.lastProgress = t;
    if (id !== undefined && this.waiting.has(id)) this.waiting.set(id, t);
  }

  /** Its response headers arrived, or it ended any other way than a timeout. */
  answered(id: number): void {
    this.waiting.delete(id);
  }

  /**
   * It hit the headers / idle deadline before a response was handed to the renderer. Returns the
   * reason to reset the transport now, or null.
   */
  timedOut(id: number): string | null {
    const t = this.now();
    this.waiting.delete(id);
    this.recent = this.recent.filter((x) => t - x < this.policy.windowMs);
    this.recent.push(t);
    let reason: string | null = null;
    if (this.recent.length >= this.policy.timeouts) {
      reason = `${this.recent.length} timeouts in ${Math.round(this.policy.windowMs / 1000)} s`;
    } else {
      for (const since of this.waiting.values()) {
        if (t - since >= this.policy.stuckMs) {
          reason = 'timeout while another request has no response';
          break;
        }
      }
    }
    if (!reason || t - this.lastReset < this.policy.cooldownMs) return null;
    return this.fire(t, reason);
  }

  /**
   * Sleep / screen unlock / network back: the pooled connections are suspect — unless a transfer
   * has just moved bytes (a lock without sleep: an upload / download in progress is not killed;
   * a really dead connection is then caught by the timeouts).
   */
  woke(ev: WakeEvent): string | null {
    const t = this.now();
    if (t - this.lastReset < this.policy.wakeCooldownMs) return null;
    if (t - this.lastProgress < this.policy.stuckMs) return null;
    return this.fire(t, ev === 'online' ? 'network online' : `power ${ev}`);
  }

  private fire(t: number, reason: string): string {
    this.lastReset = t;
    this.recent = [];
    return reason;
  }
}
