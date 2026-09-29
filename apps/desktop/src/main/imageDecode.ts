import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeImage, type NativeImage } from 'electron';
import log from 'electron-log/main';
import { fitBox, heifDisplaySize, sameShape } from '../shared/heif';

/**
 * The `native` rung of the renderer's decode ladder (renderer/lib/image/decode.ts, docs/02
 * «Изображения: клиентское сжатие и HEIC»): a HEIC photo decoded by the OS and handed back as
 * JPEG ≤ maxSide. nativeImage.createFromBuffer reads only PNG / JPEG, so the OS thumbnailer
 * does it: Quick Look on macOS (HEIC always, orientation applied), the shell thumbnail cache on
 * Windows (only with the HEIF extension installed). Quick Look stretches the picture to the box
 * it is asked for, so the box is the displayed size from the HEIF header (`ispe` + `irot`),
 * and a result of other proportions is refused (the renderer then asks the server). Linux has
 * no thumbnailer: null at once.
 */

export const NATIVE_DECODE_MAX_BYTES = 50 * 1024 * 1024;

/** Validated `{bytes, maxSide}` of the IPC call, or null. */
export function parseDecodeArgs(a: unknown): { bytes: Uint8Array; maxSide: number } | null {
  if (typeof a !== 'object' || a === null) return null;
  const r = a as Record<string, unknown>;
  const raw = r['bytes'];
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw instanceof Uint8Array ? raw : null;
  const maxSide = r['maxSide'];
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > NATIVE_DECODE_MAX_BYTES) return null;
  if (typeof maxSide !== 'number' || !Number.isInteger(maxSide) || maxSide < 16 || maxSide > 8192) return null;
  return { bytes, maxSide };
}

function toJpeg(img: NativeImage, want: { width: number; height: number }): Uint8Array | null {
  if (img.isEmpty() || !sameShape(img.getSize(), want)) return null;
  const jpeg = img.toJPEG(90);
  return jpeg.byteLength > 0 ? new Uint8Array(jpeg) : null;
}

export async function decodeImageNative(a: unknown): Promise<Uint8Array | null> {
  const args = parseDecodeArgs(a);
  if (!args || (process.platform !== 'darwin' && process.platform !== 'win32')) return null;
  const shown = heifDisplaySize(args.bytes);
  if (!shown) return null;
  const box = fitBox(shown.width, shown.height, args.maxSide);
  // The thumbnailer needs a file; the extension picks the decoder on Windows.
  const path = join(tmpdir(), `calab-decode-${randomUUID()}.heic`);
  try {
    await writeFile(path, args.bytes);
    return toJpeg(await nativeImage.createThumbnailFromPath(path, box), box);
  } catch (e) {
    log.info('native image decode failed', e);
    return null;
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}
