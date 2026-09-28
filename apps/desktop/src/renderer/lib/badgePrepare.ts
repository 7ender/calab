/**
 * A member badge picture before the upload (docs/09 #82, docs/08 «Бейдж»): any picture the
 * browser can open is centre-cropped to a square and drawn at 64×64 as WebP (the stickers'
 * quality ladder, lib/stickerPrepare), so the preview the admin sees is exactly what every
 * member gets; the server takes PNG / WebP / JPEG ≤ 128 KB and ≤ 256×256.
 */
import { browserCodec, encodeWithinLimit, webpName, type Crop, type RejectReason, type StickerCodec } from './stickerPrepare';

export const BADGE_SIDE = 64;
export const BADGE_MAX_BYTES = 128 * 1024;
/** `accept` of the file dialog. */
export const BADGE_ACCEPT = '.webp,.png,.jpg,.jpeg,image/webp,image/png,image/jpeg';

/** The centred square of a `width` × `height` picture (the longer side is trimmed evenly). */
export function squareCrop(width: number, height: number): Crop {
  const side = Math.max(1, Math.min(width, height));
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), sw: side, sh: side };
}

export type BadgePrepareResult = { ok: true; blob: Blob; name: string } | { ok: false; reason: RejectReason };

/** Turns a picked file into the 64×64 WebP badge picture, or says why it cannot be one. */
export async function prepareBadge(file: Blob & { name?: string }, codec: StickerCodec = browserCodec): Promise<BadgePrepareResult> {
  const img = await codec.decode(file);
  if (!img) return { ok: false, reason: 'broken' };
  try {
    if (!img.width || !img.height) return { ok: false, reason: 'broken' };
    const crop = squareCrop(img.width, img.height);
    const out = await encodeWithinLimit((q) => img.encode(BADGE_SIDE, BADGE_SIDE, q, crop), BADGE_MAX_BYTES);
    if (typeof out === 'string') return { ok: false, reason: out };
    return { ok: true, blob: out, name: webpName(file.name ?? 'badge') };
  } finally {
    img.close();
  }
}
