/**
 * Stream picker thumbnails (docs/09 #17): `desktopCapturer.getSources({ thumbnailSize })` is
 * asked for exactly the card's preview box × devicePixelRatio, so the preview is drawn 1:1 —
 * never upscaled (blurry) nor heavily downscaled. Shared by the renderer (what to ask for) and
 * main (validating what it is asked for).
 */

export interface ThumbSize {
  width: number;
  height: number;
}

/** Per source kind: screens and windows can have different card sizes (one big screen card). */
export interface ThumbRequest {
  screen: ThumbSize;
  window: ThumbSize;
}

/** Before the renderer measured its cards (and the old fixed size). */
export const THUMB_DEFAULT: ThumbSize = { width: 480, height: 270 };

const MIN_W = 16;
/** 4K wide at most: anything bigger is wasted IPC (the dialog is ≤ 900 CSS px wide). */
const MAX_W = 3840;
const MAX_H = 2160;

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/**
 * The thumbnail for a 16:9 preview box `cssWidth` CSS px wide on a `dpr` display: device pixels,
 * rounded, clamped. getSources keeps the source's aspect ratio inside this box, so a 16:10
 * screen comes back box-high and narrower — `object-fit: contain` then draws it 1:1.
 */
export function thumbSizeFor(cssWidth: number, dpr: number): ThumbSize {
  const d = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 4) : 1;
  const w = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth * d : THUMB_DEFAULT.width;
  const width = clampInt(w, MIN_W, MAX_W);
  return { width, height: clampInt((width * 9) / 16, 9, MAX_H) };
}

/** Main's validation of a renderer-supplied size: finite numbers, clamped; anything else → default. */
export function parseThumbSize(v: unknown): ThumbSize {
  if (typeof v !== 'object' || v === null) return THUMB_DEFAULT;
  const r = v as Record<string, unknown>;
  const w = r['width'];
  const h = r['height'];
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) return THUMB_DEFAULT;
  return { width: clampInt(w, MIN_W, MAX_W), height: clampInt(h, 9, MAX_H) };
}

export function parseThumbRequest(v: unknown): ThumbRequest {
  const r = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  return { screen: parseThumbSize(r['screen']), window: parseThumbSize(r['window']) };
}

export function sameThumb(a: ThumbSize, b: ThumbSize): boolean {
  return a.width === b.width && a.height === b.height;
}
