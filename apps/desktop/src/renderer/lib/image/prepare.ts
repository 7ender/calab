/**
 * Pictures before the upload (docs/02 «Изображения: клиентское сжатие и HEIC»):
 *  - an avatar / workspace icon is never uploaded as picked: centre-cropped to a square, drawn
 *    at AVATAR_SIDE (ICON_SIDE) — 2× the largest place it is shown — and encoded to WebP 0.85;
 *    a browser without a WebP encoder (Safari < 16 returns PNG or nothing) gets JPEG 0.88;
 *  - a HEIC chat attachment becomes JPEG 0.9 ≤ 4096 px named `.jpg` (every client can show it);
 *    any other attachment goes as it is.
 * The math and the fallback are pure and unit-tested; drawing is the injected `Encoder`.
 */
import { squareCrop } from '../badgePrepare';
import { fitWithin, type Crop } from '../stickerPrepare';
import { CONVERT_MAX_SIDE, decodeImage, isHeif, type DecodeDeps, type Decoded } from './decode';
import { ImageError } from './errors';

/** Avatars (profile, bots): the largest render is 96–128 px (profile sheet, voice tiles) → 2× of 256 for 2×-screens. */
export const AVATAR_SIDE = 512;
/** Workspace icon: shown ≤ 64 px (settings), 2× with headroom. */
export const ICON_SIDE = 256;
export const WEBP_QUALITY = 0.85;
export const JPEG_FALLBACK_QUALITY = 0.88;
export const ATTACHMENT_JPEG_QUALITY = 0.9;

export type OutType = 'image/webp' | 'image/jpeg';

export interface Encoder<T> {
  /** Draws `crop` of `src` at `width` × `height` and encodes it (canvas.toBlob); null = failed. */
  encode(src: T, crop: Crop, width: number, height: number, type: OutType, quality: number): Promise<Blob | null>;
}

/** The square crop and the output side of an avatar (never upscaled, ≥ 1). */
export function avatarPlan(width: number, height: number, side = AVATAR_SIDE): { crop: Crop; side: number } {
  const crop = squareCrop(width, height);
  return { crop, side: Math.max(1, Math.min(side, crop.sw)) };
}

/** WebP when the browser really encodes it, else JPEG (Safari < 16: toBlob gives PNG or null). */
export async function encodeWebpOrJpeg<T>(enc: Encoder<T>, src: T, crop: Crop, width: number, height: number): Promise<Blob> {
  const webp = await enc.encode(src, crop, width, height, 'image/webp', WEBP_QUALITY);
  if (webp && webp.type === 'image/webp' && webp.size > 0) return webp;
  const jpeg = await enc.encode(src, crop, width, height, 'image/jpeg', JPEG_FALLBACK_QUALITY);
  if (jpeg && jpeg.size > 0) return jpeg;
  throw new ImageError('noEncoder');
}

const base = (name: string, fallback: string): string => name.replace(/\.[^./\\]*$/, '') || fallback;
/** The name with the extension of `type`. */
export const renamed = (name: string, type: string, fallback = 'image'): string => `${base(name, fallback)}.${type === 'image/webp' ? 'webp' : 'jpg'}`;

export interface Prepared {
  blob: Blob;
  name: string;
}

/** A picked picture → the square avatar / icon to upload (never the original). */
export async function prepareAvatar<T extends Decoded>(file: Blob, name: string, side: number, deps: DecodeDeps<T>, enc: Encoder<T>): Promise<Prepared> {
  const img = await decodeImage(file, name, deps);
  try {
    if (!img.width || !img.height) throw new ImageError('broken');
    const plan = avatarPlan(img.width, img.height, side);
    const blob = await encodeWebpOrJpeg(enc, img, plan.crop, plan.side, plan.side);
    return { blob, name: renamed(name, blob.type, 'avatar') };
  } finally {
    img.close();
  }
}

/** A chat attachment: HEIC → JPEG ≤ 4096 px named `.jpg`; anything else unchanged. */
export async function prepareAttachment<T extends Decoded>(file: Blob, name: string, deps: DecodeDeps<T>, enc: Encoder<T>): Promise<Prepared> {
  if (!(await isHeif(file, name))) return { blob: file, name };
  const img = await decodeImage(file, name, deps);
  try {
    const size = fitWithin(img.width, img.height, CONVERT_MAX_SIDE);
    const full: Crop = { sx: 0, sy: 0, sw: img.width, sh: img.height };
    const blob = await enc.encode(img, full, size.width, size.height, 'image/jpeg', ATTACHMENT_JPEG_QUALITY);
    if (!blob || blob.size === 0) throw new ImageError('noEncoder');
    return { blob, name: renamed(name, 'image/jpeg', 'photo') };
  } finally {
    img.close();
  }
}
