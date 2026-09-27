import type { AnnotOverlayEvent } from '../../../shared/annot';

/**
 * What is drawn over one stream (ADR-0028): laser pointers and pen strokes of its viewers, in
 * normalized frame coordinates. Pure state + time; drawing is `paint.ts`. Used by the viewer's
 * canvas over the <video> and by the presenter's overlay window (the same events over IPC).
 */

/** Pointer: gone this long after its last message; the tail of it fades out. */
export const POINTER_TTL_MS = 1000;
export const POINTER_FADE_MS = 250;
/** Stroke: gone this long after its last point; the last second fades out. */
export const STROKE_TTL_MS = 5000;
export const STROKE_FADE_MS = 1000;
/** Memory bounds against a flood that passed the rate limit. */
export const MAX_STROKES = 200;
export const MAX_STROKE_POINTS = 4000;

/** A validated annotation, ready for a scene (plain data: it also crosses IPC to the overlay). */
export type SceneEvent = AnnotOverlayEvent;

export interface Pointer {
  from: string;
  name: string;
  color: number;
  x: number;
  y: number;
  at: number;
}

export interface Stroke {
  from: string;
  id: number;
  color: number;
  points: number[];
  /** Time of the last point (fading starts from here). */
  at: number;
  ended: boolean;
}

/** 1 while fresh, then linearly to 0 over the last `fade` ms of `ttl`. */
export function fadeAlpha(age: number, ttl: number, fade: number): number {
  if (age >= ttl) return 0;
  if (age <= ttl - fade) return 1;
  return (ttl - age) / fade;
}

export class AnnotScene {
  private readonly pointers = new Map<string, Pointer>();
  private strokes: Stroke[] = [];

  apply(ev: SceneEvent, now: number): void {
    if (ev.kind === 'clear') {
      this.strokes = ev.owner ? [] : this.strokes.filter((s) => s.from !== ev.from);
      if (ev.owner) this.pointers.clear();
      return;
    }
    if (ev.kind === 'pointer') {
      const x = ev.points[0];
      const y = ev.points[1];
      if (x === undefined || y === undefined) return;
      this.pointers.set(ev.from, { from: ev.from, name: ev.name, color: ev.color, x, y, at: now });
      return;
    }
    let s = this.strokes.find((o) => o.from === ev.from && o.id === ev.strokeId && !o.ended);
    if (!s) {
      if (ev.points.length === 0) return;
      s = { from: ev.from, id: ev.strokeId, color: ev.color, points: [], at: now, ended: false };
      this.strokes.push(s);
      if (this.strokes.length > MAX_STROKES) this.strokes.splice(0, this.strokes.length - MAX_STROKES);
    }
    const room = MAX_STROKE_POINTS * 2 - s.points.length;
    if (room > 0) s.points.push(...ev.points.slice(0, room));
    if (ev.points.length) s.at = now;
    if (ev.strokeEnd) s.ended = true;
  }

  /** Drops what has faded; true while anything is left to draw. */
  prune(now: number): boolean {
    for (const [k, p] of this.pointers) if (now - p.at >= POINTER_TTL_MS) this.pointers.delete(k);
    // A stroke still being drawn stays; it starts fading from its last point once ended or idle.
    this.strokes = this.strokes.filter((s) => now - s.at < STROKE_TTL_MS);
    return !this.empty;
  }

  get empty(): boolean {
    return this.pointers.size === 0 && this.strokes.length === 0;
  }

  /** Everyone's strokes of `from` gone (they left the call). */
  forget(from: string): void {
    this.pointers.delete(from);
    this.strokes = this.strokes.filter((s) => s.from !== from);
  }

  clear(): void {
    this.pointers.clear();
    this.strokes = [];
  }

  visiblePointers(now: number): Array<Pointer & { alpha: number }> {
    const out: Array<Pointer & { alpha: number }> = [];
    for (const p of this.pointers.values()) {
      const alpha = fadeAlpha(now - p.at, POINTER_TTL_MS, POINTER_FADE_MS);
      if (alpha > 0) out.push({ ...p, alpha });
    }
    return out;
  }

  visibleStrokes(now: number): Array<Stroke & { alpha: number }> {
    const out: Array<Stroke & { alpha: number }> = [];
    for (const s of this.strokes) {
      const alpha = fadeAlpha(now - s.at, STROKE_TTL_MS, STROKE_FADE_MS);
      if (alpha > 0) out.push({ ...s, alpha });
    }
    return out;
  }
}
