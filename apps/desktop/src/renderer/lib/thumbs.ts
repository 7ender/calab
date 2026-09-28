/**
 * Chat image previews on Retina (docs/09 #62, docs/05 `GET /api/files/{id}/thumbnail?w=`): the
 * server keeps a 512 px thumbnail and makes a 1024 px one on demand (longer side, never
 * upscaled). A preview asks for 1024 only when the 512 one would be enlarged on a 2× screen.
 * Pure (unit-tested in thumbs.test.ts).
 */

export const THUMB_SMALL = 512;
export const THUMB_LARGE = 1024;
/** Enlarging a thumbnail by up to 2 % is invisible (a 260 px box on 2× takes 520 of 512 px). */
const SLACK = 1.02;
/** A box up to this many CSS px on each side (album cells) stays on 512 even on 2× (traffic). */
export const SMALL_BOX = 260;

/** Size of the server's thumbnail of a w×h image fitted into side×side (never upscaled). */
export function thumbSize(w: number, h: number, side: number): { w: number; h: number } {
  if (w <= side && h <= side) return { w, h };
  if (w >= h) return { w: side, h: Math.max(1, Math.floor((h * side) / w)) };
  return { w: Math.max(1, Math.floor((w * side) / h)), h: side };
}

/**
 * Whether a preview box of boxW×boxH CSS px (object-fit: cover) needs the 1024 thumbnail on a
 * 2× screen: the 512 one is smaller than the drawn image in device px. Boxes up to SMALL_BOX
 * never do. Unknown image size → decided by the box alone, as for a landscape 512 px thumbnail.
 */
export function wantsLargeThumb(width: number | undefined, height: number | undefined, boxW: number, boxH: number): boolean {
  if (boxW <= SMALL_BOX && boxH <= SMALL_BOX) return false;
  if (!width || !height) return 2 * Math.max(boxW, boxH) > THUMB_SMALL * SLACK;
  if (Math.max(width, height) <= THUMB_SMALL) return false; // the 512 one already is the original size
  const t = thumbSize(width, height, THUMB_SMALL);
  const drawnW = Math.max(boxW, (boxH * width) / height); // cover: the image fills the box
  return 2 * drawnW > t.w * SLACK;
}

export const thumbWidthPath = (path: string, side: number): string => `${path}?w=${side}`;

/** srcset for directly loadable URLs: 512 at 1×, 1024 at 2× (the browser picks by DPR). */
export const densitySrcSet = (small: string, large: string): string => `${small} 1x, ${large} 2x`;

/** One URL where srcset can't be used (web: media are fetched as blobs): 1024 from 1.5× DPR on. */
export const pickByDensity = <T>(small: T, large: T, dpr: number): T => (dpr >= 1.5 ? large : small);
