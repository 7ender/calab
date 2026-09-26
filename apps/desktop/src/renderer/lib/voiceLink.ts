/**
 * Voice connection presentation and diagnostics (docs/09 P0 #1, 0.2.1): the debounced phase the
 * voice panel shows, readable connect errors, and CSP-violation parsing. Pure — timers injected.
 */
import type { VoicePhase } from '../stores/voice';

/** A LiveKit reconnect shorter than this never reaches the panel (no blinking title). */
export const RECONNECT_DISPLAY_DELAY_MS = 1500;
/** From this many failed attempts in a row the notice shows the reason and «Повторить». */
export const RETRY_OFFER_AFTER = 3;

export interface PhaseTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: PhaseTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * The phase the voice panel shows. Leaving `connected` for `reconnecting` is shown only once it
 * has lasted `delayMs` (LiveKit resumes most drops within a second); back to `connected` — at
 * once. Every other transition is immediate. One reconnect cycle is one `reconnecting` display,
 * however many attempts it takes.
 */
export class DisplayedPhase {
  private shown: VoicePhase;
  private timer: unknown = null;

  constructor(
    initial: VoicePhase,
    private readonly onChange: (phase: VoicePhase) => void,
    private readonly timers: PhaseTimers = realTimers,
    private readonly delayMs = RECONNECT_DISPLAY_DELAY_MS,
  ) {
    this.shown = initial;
  }

  get phase(): VoicePhase {
    return this.shown;
  }

  update(phase: VoicePhase): void {
    if (phase === 'reconnecting' && this.shown === 'connected' && this.delayMs > 0) {
      if (this.timer !== null) return; // already counting this outage
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        this.set('reconnecting');
      }, this.delayMs);
      return;
    }
    this.cancel();
    this.set(phase);
  }

  dispose(): void {
    this.cancel();
  }

  private cancel(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private set(phase: VoicePhase): void {
    if (this.shown === phase) return;
    this.shown = phase;
    this.onChange(phase);
  }
}

/** `wss://rtc.calab.ru/…` → `rtc.calab.ru` (null for a non-URL). */
export function hostOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  reasonName?: unknown;
  status?: unknown;
}

/**
 * One line for an error from livekit-client's `room.connect` (ConnectionError: reasonName +
 * HTTP status of the signal request) or anything else thrown on the way. Diagnostics, shown
 * after the human text — not a replacement for it.
 */
export function describeConnectError(err: unknown): string {
  if (typeof err === 'string') return err;
  if (!err || typeof err !== 'object') return String(err);
  const e = err as ErrorLike;
  const name = typeof e.name === 'string' && e.name !== 'Error' ? e.name : '';
  const reason = typeof e.reasonName === 'string' && e.reasonName ? e.reasonName : '';
  const status = typeof e.status === 'number' && e.status > 0 ? `HTTP ${e.status}` : '';
  const msg = typeof e.message === 'string' ? e.message.trim() : '';
  const head = [name, reason].filter(Boolean).join(' / ');
  const tail = [msg, status].filter(Boolean).join(', ');
  return [head, tail].filter(Boolean).join(': ') || 'unknown error';
}

/** A LiveKit `Disconnected` reason (enum number or name) as a line. */
export function describeDisconnect(reason: unknown): string {
  return `disconnected: ${typeof reason === 'number' || typeof reason === 'string' ? String(reason) : 'unknown'}`;
}

interface ViolationLike {
  effectiveDirective?: string;
  violatedDirective?: string;
  blockedURI?: string;
}

/**
 * `securitypolicyviolation` → the host whose connection our CSP refused, for network directives
 * (connect-src: WebSocket / fetch) with an absolute ws(s)/http(s) URL; null otherwise.
 */
export function cspBlockedHost(ev: ViolationLike): string | null {
  const directive = ev.effectiveDirective || ev.violatedDirective || '';
  if (!directive.startsWith('connect-src')) return null;
  const uri = ev.blockedURI ?? '';
  if (!/^(wss?|https?):\/\//i.test(uri)) return null;
  return hostOfUrl(uri);
}

/** Whether the notice should explain the failure and offer «Повторить». */
export function offerRetry(phase: VoicePhase, attempts: number): boolean {
  return phase === 'blocked' || (phase === 'reconnecting' && attempts >= RETRY_OFFER_AFTER);
}
