import { MAX_POINTS } from './codec';
import { SEND_INTERVAL_MS, farEnough } from './limits';

/**
 * Send side of annotations (ADR-0028): at most one message per SEND_INTERVAL_MS (≤ 20/s, under
 * the receivers' 30/s). The pointer sends only its latest position; a stroke sends its new points
 * as one batch (≤ MAX_POINTS, thinned). Clear goes out at once.
 */

export interface OutMessage {
  kind: 'pointer' | 'stroke' | 'clear';
  streamSid: string;
  color: number;
  points: number[];
  strokeId: number;
  strokeEnd: boolean;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

interface StrokeState {
  sid: string;
  color: number;
  id: number;
  /** Points not sent yet. */
  pending: number[];
  last: [number, number] | null;
  ended: boolean;
}

export class AnnotSender {
  private pointer: { sid: string; color: number; x: number; y: number } | null = null;
  private stroke: StrokeState | null = null;
  private timer: number | null = null;
  private lastSent = -Infinity;
  private nextStrokeId = 1 + Math.floor(Math.random() * 0x7fff0000);

  constructor(
    private readonly send: (m: OutMessage) => void,
    private readonly clock: Clock = realClock,
  ) {}

  movePointer(sid: string, color: number, x: number, y: number): void {
    this.pointer = { sid, color, x, y };
    this.schedule();
  }

  startStroke(sid: string, color: number, x: number, y: number): void {
    if (this.stroke && !this.stroke.ended) this.endStroke();
    this.flushNow(); // the previous stroke's tail first: one stroke per batch
    this.stroke = { sid, color, id: this.nextStrokeId++, pending: [x, y], last: [x, y], ended: false };
    this.schedule();
  }

  moveStroke(x: number, y: number): void {
    const s = this.stroke;
    if (!s || s.ended || !farEnough(s.last, x, y)) return;
    s.pending.push(x, y);
    s.last = [x, y];
    this.schedule();
  }

  endStroke(): void {
    const s = this.stroke;
    if (!s || s.ended) return;
    s.ended = true;
    this.schedule();
  }

  clear(sid: string, color: number): void {
    this.flushNow();
    this.send({ kind: 'clear', streamSid: sid, color, points: [], strokeId: 0, strokeEnd: false });
  }

  /** Drop everything pending (left the call / stream gone). */
  reset(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.pointer = null;
    this.stroke = null;
  }

  private schedule(): void {
    if (this.timer !== null) return;
    const wait = Math.max(0, this.lastSent + SEND_INTERVAL_MS - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flushNow(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    while (this.hasPending()) this.flush();
  }

  private hasPending(): boolean {
    const s = this.stroke;
    return this.pointer !== null || (s !== null && (s.pending.length > 0 || s.ended));
  }

  /** One message: the stroke batch (or its end), else the pointer's latest position. */
  private flush(): void {
    const s = this.stroke;
    if (s && (s.pending.length > 0 || s.ended)) {
      const points = s.pending.splice(0, MAX_POINTS * 2);
      const end = s.ended && s.pending.length === 0;
      this.send({ kind: 'stroke', streamSid: s.sid, color: s.color, points, strokeId: s.id, strokeEnd: end });
      if (end) this.stroke = null;
    } else if (this.pointer) {
      const p = this.pointer;
      this.pointer = null;
      this.send({ kind: 'pointer', streamSid: p.sid, color: p.color, points: [p.x, p.y], strokeId: 0, strokeEnd: false });
    } else return;
    this.lastSent = this.clock.now();
    if (this.hasPending()) this.schedule();
  }
}
