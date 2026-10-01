/** Geometry of the mode switcher's sliding pill (docs/08): the active segment's box inside the track. */
export interface PillBox {
  /** Offset from the track's padding box left edge, px. */
  x: number;
  width: number;
}

/**
 * The pill's box from two client rects (track and active segment). Snapped to whole device pixels
 * so the pill edge stays crisp; null when the segment is not laid out yet (hidden, 0 wide).
 */
export function pillBox(track: { left: number; borderLeft?: number }, seg: { left: number; width: number }, dpr = 1): PillBox | null {
  if (!(seg.width > 0)) return null;
  const snap = (v: number): number => Math.round(v * dpr) / dpr;
  return { x: snap(seg.left - track.left - (track.borderLeft ?? 0)), width: snap(seg.width) };
}

export function pillStyle(box: PillBox): { transform: string; width: string } {
  return { transform: `translateX(${box.x}px)`, width: `${box.width}px` };
}
