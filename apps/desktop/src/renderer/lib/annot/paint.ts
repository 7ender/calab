import type { AnnotScene } from './scene';

/**
 * Drawing a scene on a 2D canvas (the viewer's layer over <video> and the presenter's overlay).
 * Coordinates are normalized to the video *frame*: with `object-contain` the frame sits inside
 * the element with letterbox bars, so everything maps through `contentRect`.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The frame's box inside an element of `boxW×boxH` showing a `vidW×vidH` video (object-contain). */
export function contentRect(boxW: number, boxH: number, vidW: number, vidH: number): Rect {
  if (boxW <= 0 || boxH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  if (vidW <= 0 || vidH <= 0) return { x: 0, y: 0, w: boxW, h: boxH };
  const k = Math.min(boxW / vidW, boxH / vidH);
  const w = vidW * k;
  const h = vidH * k;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/** A point in the element (CSS px) → normalized frame coordinates, or null outside the frame. */
export function toFrame(rect: Rect, px: number, py: number): [number, number] | null {
  if (rect.w <= 0 || rect.h <= 0) return null;
  const x = (px - rect.x) / rect.w;
  const y = (py - rect.y) / rect.h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return [x, y];
}

/** Like toFrame, but clamped to the frame's edge (a stroke that leaves the frame follows its edge). */
export function toFrameClamped(rect: Rect, px: number, py: number): [number, number] | null {
  if (rect.w <= 0 || rect.h <= 0) return null;
  const c = (v: number): number => Math.min(1, Math.max(0, v));
  return [c((px - rect.x) / rect.w), c((py - rect.y) / rect.h)];
}

/**
 * Pen colours (docs/08 «Аннотации»): saturated system colours that read on any screen content.
 * They are content, not UI chrome — that is why they are not theme tokens.
 */
export const ANNOT_COLORS: readonly number[] = [0xff453a, 0xffd60a, 0x30d158, 0x0a84ff, 0xbf5af2, 0xffffff];

/** The default colour of a participant: stable per user id («цветом участника»). */
export function colorFor(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return ANNOT_COLORS[h % (ANNOT_COLORS.length - 1)] ?? 0xff453a; // white is chosen, never default
}

export const css = (c: number, a = 1): string => `rgba(${(c >> 16) & 255}, ${(c >> 8) & 255}, ${c & 255}, ${a})`;

export interface PaintOptions {
  /** Stroke width in CSS px. */
  lineWidth: number;
  /** Pointer dot radius in CSS px. */
  dot: number;
  /** Label font size in CSS px. */
  font: number;
}

export const TILE_PAINT: PaintOptions = { lineWidth: 3, dot: 6, font: 12 };
export const OVERLAY_PAINT: PaintOptions = { lineWidth: 4, dot: 8, font: 13 };

/**
 * One frame: clears the canvas (sized in device px, `dpr` = device px per CSS px) and draws the
 * strokes, then the pointers with their names on top.
 */
export function paintScene(g: CanvasRenderingContext2D, scene: AnnotScene, rect: Rect, now: number, dpr: number, o: PaintOptions = TILE_PAINT): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const X = (v: number): number => rect.x + v * rect.w;
  const Y = (v: number): number => rect.y + v * rect.h;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = o.lineWidth;
  for (const s of scene.visibleStrokes(now)) {
    const p = s.points;
    if (p.length < 2) continue;
    g.strokeStyle = css(s.color, s.alpha);
    g.beginPath();
    g.moveTo(X(p[0] ?? 0), Y(p[1] ?? 0));
    if (p.length === 2) g.lineTo(X(p[0] ?? 0) + 0.01, Y(p[1] ?? 0)); // a dot
    for (let i = 2; i + 1 < p.length; i += 2) g.lineTo(X(p[i] ?? 0), Y(p[i + 1] ?? 0));
    g.stroke();
  }
  g.font = `600 ${o.font}px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif`;
  g.textBaseline = 'middle';
  for (const p of scene.visiblePointers(now)) {
    const x = X(p.x);
    const y = Y(p.y);
    // Dot with a white rim and a soft glow: visible on dark and light content alike.
    g.shadowColor = css(p.color, 0.8 * p.alpha);
    g.shadowBlur = o.dot * 1.5;
    g.fillStyle = css(p.color, p.alpha);
    g.beginPath();
    g.arc(x, y, o.dot, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    g.lineWidth = 2;
    g.strokeStyle = `rgba(255, 255, 255, ${0.9 * p.alpha})`;
    g.stroke();
    g.lineWidth = o.lineWidth;
    // Name pill to the lower right of the dot.
    const pad = 6;
    const tw = g.measureText(p.name).width;
    const lh = o.font + 8;
    const lx = x + o.dot + 4;
    const ly = y + o.dot - 2;
    g.fillStyle = `rgba(0, 0, 0, ${0.6 * p.alpha})`;
    g.beginPath();
    g.roundRect(lx, ly, tw + pad * 2, lh, lh / 2);
    g.fill();
    g.fillStyle = `rgba(255, 255, 255, ${p.alpha})`;
    g.fillText(p.name, lx + pad, ly + lh / 2);
  }
}
