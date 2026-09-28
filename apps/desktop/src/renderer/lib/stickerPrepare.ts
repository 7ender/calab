/**
 * Sticker files before the upload (ADR-0030 §6, docs/08 «Стикеры»): the server takes only WebP
 * ≤ 512×512 (≤ 512 KB still, ≤ 1 MB animated), so the client fits what it can — a still PNG /
 * JPEG / WebP larger than 512 is scaled down to 512 on the longer side and encoded to WebP
 * (quality 0.92, stepping down to 0.7 while it is over 512 KB); a PNG / JPEG within 512 is
 * encoded to WebP as is. An animated WebP is never re-encoded (a canvas keeps one frame): too
 * big → a clear refusal on its card. GIF is refused with a hint to convert it.
 *
 * The decisions (sniffing the header, the plan, the quality ladder) are pure and unit-tested;
 * decoding / drawing / encoding is the thin `browserCodec` below (no canvas in jsdom).
 */

export const STICKER_SIDE = 512;
export const STICKER_MAX_STATIC = 512 * 1024;
export const STICKER_MAX_ANIMATED = 1024 * 1024;
/** `accept` of the file dialog; drops are filtered by `stickerFileKind`. */
export const STICKER_ACCEPT = '.webp,.png,.jpg,.jpeg,image/webp,image/png,image/jpeg';
/** WebP quality ladder for a still that is over STICKER_MAX_STATIC after the first encode. */
export const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.7] as const;

export type StickerKind = 'webp' | 'png' | 'jpeg' | 'gif' | 'other';

/** Why a file cannot become a sticker (an i18n text per reason: `stk.reject.*`). */
export type RejectReason = 'gif' | 'unsupported' | 'animatedTooBig' | 'tooHeavy' | 'broken' | 'noEncoder';

export interface Sniff {
  kind: StickerKind;
  /** 0 when the header does not say (JPEG: known only after decoding). */
  width: number;
  height: number;
  animated: boolean;
}

export type Plan = { do: 'keep' } | { do: 'encode'; width: number; height: number; scaled: boolean } | { do: 'reject'; reason: RejectReason };

export interface PreparedSticker {
  blob: Blob;
  /** Upload name: the original name with the `.webp` extension. */
  name: string;
  width: number;
  height: number;
  size: number;
  animated: boolean;
  /** Scaled down to STICKER_SIDE on the longer side. */
  scaled: boolean;
}

/** A refusal keeps what the header said (an animated WebP preview then stands still). */
export type PrepareResult = { ok: true; sticker: PreparedSticker } | { ok: false; reason: RejectReason; sniff?: Sniff };

/** Kind by the name / MIME type — the first filter of a drop (the header decides later). */
export function stickerFileKind(name: string, type: string): StickerKind {
  const n = name.toLowerCase();
  if (type === 'image/webp' || n.endsWith('.webp')) return 'webp';
  if (type === 'image/png' || n.endsWith('.png')) return 'png';
  if (type === 'image/jpeg' || /\.jpe?g$/.test(n)) return 'jpeg';
  if (type === 'image/gif' || n.endsWith('.gif')) return 'gif';
  return 'other';
}

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));
const u16le = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number): number => u16le(b, at) | ((b[at + 2] ?? 0) << 16);
const u32le = (b: Uint8Array, at: number): number => (u24le(b, at) | ((b[at + 3] ?? 0) << 24)) >>> 0;
const u32be = (b: Uint8Array, at: number): number => (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)) >>> 0;

/** WebP canvas size and whether it is an animation (VP8X animation flag or an `ANIM` chunk). */
function sniffWebp(b: Uint8Array): Sniff {
  const out: Sniff = { kind: 'webp', width: 0, height: 0, animated: false };
  for (let off = 12; off + 8 <= b.length; ) {
    const id = ascii(b, off, 4);
    const size = u32le(b, off + 4);
    const p = off + 8;
    if (id === 'VP8X' && size >= 10) {
      out.animated ||= ((b[p] ?? 0) & 0x02) !== 0;
      out.width = u24le(b, p + 4) + 1;
      out.height = u24le(b, p + 7) + 1;
    } else if (id === 'ANIM') {
      out.animated = true;
    } else if (id === 'VP8 ' && size >= 10 && !out.width) {
      out.width = u16le(b, p + 6) & 0x3fff;
      out.height = u16le(b, p + 8) & 0x3fff;
    } else if (id === 'VP8L' && size >= 5 && !out.width) {
      const v = u32le(b, p + 1);
      out.width = (v & 0x3fff) + 1;
      out.height = ((v >>> 14) & 0x3fff) + 1;
    }
    off = p + size + (size & 1);
  }
  return out;
}

/** What the file really is, by its first bytes (a renamed file is caught here). */
export function sniffImage(b: Uint8Array): Sniff {
  const none = { width: 0, height: 0, animated: false };
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return sniffWebp(b);
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return { kind: 'png', width: u32be(b, 16), height: u32be(b, 20), animated: false };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'jpeg', ...none };
  if (b.length >= 6 && ascii(b, 0, 3) === 'GIF') return { kind: 'gif', ...none };
  return { kind: 'other', ...none };
}

/** The size within `max` × `max` with the same proportions (never upscaled, sides ≥ 1). */
export function fitWithin(width: number, height: number, max = STICKER_SIDE): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/**
 * What to do with a file: `s` is the sniffed header, for PNG / JPEG / an oversized still WebP
 * with the decoded size; `bytes` — the file size.
 */
export function planSticker(s: Sniff, bytes: number): Plan {
  switch (s.kind) {
    case 'gif':
      return { do: 'reject', reason: 'gif' };
    case 'other':
      return { do: 'reject', reason: 'unsupported' };
    case 'webp':
      if (!s.width || !s.height) return { do: 'reject', reason: 'broken' };
      if (s.animated) {
        const fits = s.width <= STICKER_SIDE && s.height <= STICKER_SIDE && bytes <= STICKER_MAX_ANIMATED;
        return fits ? { do: 'keep' } : { do: 'reject', reason: 'animatedTooBig' };
      }
      if (s.width <= STICKER_SIDE && s.height <= STICKER_SIDE && bytes <= STICKER_MAX_STATIC) return { do: 'keep' };
      break;
    case 'png':
    case 'jpeg':
      if (!s.width || !s.height) return { do: 'reject', reason: 'broken' };
      break;
  }
  const fit = fitWithin(s.width, s.height);
  return { do: 'encode', ...fit, scaled: fit.width !== s.width || fit.height !== s.height };
}

/**
 * Encodes down the quality ladder until the result fits `limit`. `null` from the encoder →
 * `noEncoder` (no WebP encoding here: Safari's canvas gives PNG); nothing fits → `tooHeavy`.
 */
export async function encodeWithinLimit(encode: (quality: number) => Promise<Blob | null>, limit = STICKER_MAX_STATIC): Promise<Blob | RejectReason> {
  for (const q of QUALITY_STEPS) {
    const blob = await encode(q);
    if (!blob || blob.type !== 'image/webp') return 'noEncoder';
    if (blob.size <= limit) return blob;
  }
  return 'tooHeavy';
}

/** A source rectangle of a decoded picture (a square crop of a badge, lib/badgePrepare). */
export interface Crop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * A decoded picture: its natural size and an encoder of it (or of its `crop`) scaled to
 * `width` × `height`.
 */
export interface DecodedImage {
  width: number;
  height: number;
  encode(width: number, height: number, quality: number, crop?: Crop): Promise<Blob | null>;
  close(): void;
}

export interface StickerCodec {
  /** `null` when the file cannot be decoded. */
  decode(file: Blob): Promise<DecodedImage | null>;
}

/** Decoding with createImageBitmap (EXIF orientation applied), encoding with a 2D canvas. */
export const browserCodec: StickerCodec = {
  async decode(file) {
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(file);
    } catch {
      return null;
    }
    return {
      width: bmp.width,
      height: bmp.height,
      encode(width, height, quality, crop) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return Promise.resolve(null);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        if (crop) ctx.drawImage(bmp, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
        else ctx.drawImage(bmp, 0, 0, width, height);
        return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
      },
      close: () => bmp.close(),
    };
  },
};

export const webpName = (name: string): string => `${name.replace(/\.[^./\\]*$/, '') || 'sticker'}.webp`;

/** Turns a picked / dropped file into an uploadable sticker, or says why it cannot be one. */
export async function prepareSticker(file: Blob & { name?: string }, codec: StickerCodec = browserCodec): Promise<PrepareResult> {
  const name = webpName(file.name ?? 'sticker');
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const sniff = sniffImage(head);
  // A still WebP within the limits goes as it is; everything else we might encode is decoded
  // first (JPEG headers do not carry the size; EXIF rotation may swap the sides).
  const first = planSticker(sniff, file.size);
  if (first.do === 'reject') return { ok: false, reason: first.reason, sniff };
  if (first.do === 'keep') {
    return { ok: true, sticker: { blob: file, name, width: sniff.width, height: sniff.height, size: file.size, animated: sniff.animated, scaled: false } };
  }
  const img = await codec.decode(file);
  if (!img) return { ok: false, reason: 'broken' };
  try {
    const plan = planSticker({ ...sniff, width: img.width, height: img.height }, file.size);
    if (plan.do !== 'encode') return plan.do === 'reject' ? { ok: false, reason: plan.reason } : { ok: false, reason: 'broken' };
    const out = await encodeWithinLimit((q) => img.encode(plan.width, plan.height, q));
    if (typeof out === 'string') return { ok: false, reason: out };
    return { ok: true, sticker: { blob: out, name, width: plan.width, height: plan.height, size: out.size, animated: false, scaled: plan.scaled } };
  } finally {
    img.close();
  }
}
