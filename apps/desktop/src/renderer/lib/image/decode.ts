/**
 * The decode ladder for a picked / dropped picture (docs/02 «Изображения: клиентское сжатие и
 * HEIC»). Chromium has no HEIF decoder, so an iPhone photo (HEIC) needs a way around it:
 *
 *  1. `bitmap` — createImageBitmap with the EXIF orientation applied (JPEG / PNG / WebP / GIF /
 *     AVIF everywhere; HEIC in Safari ≥ 17);
 *  2. `native` — Electron main (nativeImage; macOS ImageIO / Quick Look decode HEIC, Windows only
 *     with the HEIF extension installed — detected by the result) returns JPEG bytes;
 *  3. `server` — POST /api/files/convert?to=jpeg (ffmpeg on the server; 501 when it has none);
 *  4. nothing opened it → ImageError `heicUnsupported` («HEIC не поддерживается…»).
 *
 * Steps 2–3 are tried only for HEIF: any other file the browser cannot open is simply broken.
 * Pure: the rungs are injected (lib/image/index.ts wires the platform ones), unit-tested here.
 */
import { sniffHeif } from '../../../shared/heif';
import { ImageError } from './errors';

export { sniffHeif };

/** The longest side a converted HEIC keeps (native / server rungs and chat attachments). */
export const CONVERT_MAX_SIDE = 4096;

export type DecodeStep = 'bitmap' | 'native' | 'server';

/** A decoded picture (ImageBitmap in the app, a fake in tests). */
export interface Decoded {
  width: number;
  height: number;
  close(): void;
}

export interface DecodeDeps<T extends Decoded> {
  /** createImageBitmap(file, {imageOrientation: 'from-image'}); null when it cannot. */
  bitmap(b: Blob): Promise<T | null>;
  /** Electron main: the picture as JPEG ≤ `maxSide`, or null. Absent on the web. */
  native?: (b: Blob, maxSide: number) => Promise<Blob | null>;
  /** The server's HEIC → JPEG, or null when it cannot (501 / 415 / 422). */
  server?: (b: Blob, name: string) => Promise<Blob | null>;
}

/** Which rungs to try, in order, for a file (`heif`: sniffed or named HEIC/HEIF). */
export function decodeLadder(heif: boolean, has: { native: boolean; server: boolean }): DecodeStep[] {
  const steps: DecodeStep[] = ['bitmap'];
  if (!heif) return steps;
  if (has.native) steps.push('native');
  if (has.server) steps.push('server');
  return steps;
}

/** HEIC/HEIF by the name or the declared type (the header decides when it is readable). */
export function namedHeif(name: string, type: string): boolean {
  return /\.(heic|heif)$/i.test(name) || type === 'image/heic' || type === 'image/heif' || type === 'image/heic-sequence' || type === 'image/heif-sequence';
}

/** HEIF by the header, else by the name / type. */
export async function isHeif(file: Blob, name: string): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  return sniffHeif(head) || namedHeif(name, file.type);
}

/** Decodes `file` (called `name`) down the ladder; throws ImageError `heicUnsupported` / `broken`. */
export async function decodeImage<T extends Decoded>(file: Blob, name: string, deps: DecodeDeps<T>): Promise<T> {
  const heif = await isHeif(file, name);
  for (const step of decodeLadder(heif, { native: !!deps.native, server: !!deps.server })) {
    let src: Blob | null = file;
    if (step === 'native') src = (await deps.native?.(file, CONVERT_MAX_SIDE)) ?? null;
    if (step === 'server') src = (await deps.server?.(file, name || 'image.heic')) ?? null;
    if (!src) continue;
    const img = await deps.bitmap(src);
    if (img) return img;
  }
  throw new ImageError(heif ? 'heicUnsupported' : 'broken');
}
