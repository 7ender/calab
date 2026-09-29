/**
 * HEIF (HEIC) header facts without decoding (docs/02 «Изображения: клиентское сжатие и HEIC»):
 * whether bytes are HEIF (same rule as the server's `files.IsHEIF`) and the displayed size of
 * the primary image — `ispe` of the primary item, sides swapped by an odd `irot`. Main needs
 * the size: the OS thumbnailer (Quick Look) stretches the picture to whatever box it is asked
 * for, so it must be asked for the right proportions.
 */

const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

const ascii = (b: Uint8Array, at: number): string => String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);
const u16 = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32 = (b: Uint8Array, at: number): number => (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)) >>> 0;

/**
 * Whether `head` (the first bytes) starts a HEIF image: an ISO-BMFF `ftyp` with a HEIF brand
 * and without `avif` / `avis` (AVIF shares `mif1`, and browsers decode it).
 */
export function sniffHeif(head: Uint8Array): boolean {
  if (head.length < 16 || ascii(head, 4) !== 'ftyp') return false;
  let size = u32(head, 0);
  if (size < 16 || size > head.length) size = head.length;
  let heif = false;
  for (let off = 8; off + 4 <= size; off += 4) {
    if (off === 12) continue; // minor_version
    const brand = ascii(head, off);
    if (brand === 'avif' || brand === 'avis') return false;
    heif ||= HEIF_BRANDS.has(brand);
  }
  return heif;
}

interface Box {
  type: string;
  /** Payload span. */
  start: number;
  end: number;
}

function children(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  for (let off = start; off + 8 <= end && out.length < 4096; ) {
    let size = u32(b, off);
    let head = 8;
    if (size === 1) {
      // 64-bit size: pictures here are ≤ 50 MB, the high word must be 0.
      if (u32(b, off + 8) !== 0) return out;
      size = u32(b, off + 12);
      head = 16;
    } else if (size === 0) size = end - off;
    if (size < head || off + size > end) return out;
    out.push({ type: ascii(b, off + 4), start: off + head, end: off + size });
    off += size;
  }
  return out;
}

const child = (b: Uint8Array, box: Box | undefined, type: string, skip = 0): Box | undefined =>
  box ? children(b, box.start + skip, box.end).find((c) => c.type === type) : undefined;

/** The displayed width × height of the primary image, or null when the header does not say. */
export function heifDisplaySize(b: Uint8Array): { width: number; height: number } | null {
  if (!sniffHeif(b.subarray(0, 64))) return null;
  const meta = children(b, 0, b.length).find((c) => c.type === 'meta');
  const pitm = child(b, meta, 'pitm', 4);
  const iprp = child(b, meta, 'iprp', 4);
  const ipco = child(b, iprp, 'ipco');
  if (!meta || !pitm || !iprp || !ipco) return null;
  const primary = b[pitm.start] === 0 ? u16(b, pitm.start + 4) : u32(b, pitm.start + 4);
  const props = children(b, ipco.start, ipco.end);
  // ipma: item → 1-based ipco indices.
  const indices: number[] = [];
  for (const ipma of children(b, iprp.start, iprp.end).filter((c) => c.type === 'ipma')) {
    const version = b[ipma.start] ?? 0;
    const wide = ((b[ipma.start + 3] ?? 0) & 1) === 1;
    const count = u32(b, ipma.start + 4);
    let pos = ipma.start + 8;
    for (let e = 0; e < count && pos < ipma.end; e++) {
      const item = version < 1 ? u16(b, pos) : u32(b, pos);
      pos += version < 1 ? 2 : 4;
      const n = b[pos] ?? 0;
      pos += 1;
      for (let a = 0; a < n; a++) {
        const idx = wide ? u16(b, pos) & 0x7fff : (b[pos] ?? 0) & 0x7f;
        pos += wide ? 2 : 1;
        if (item === primary) indices.push(idx);
      }
    }
  }
  let size: { width: number; height: number } | null = null;
  let quarterTurns = 0;
  for (const i of indices) {
    const p = props[i - 1];
    if (p?.type === 'ispe' && p.end - p.start >= 12) size = { width: u32(b, p.start + 4), height: u32(b, p.start + 8) };
    if (p?.type === 'irot' && p.end > p.start) quarterTurns += (b[p.start] ?? 0) & 3;
  }
  if (!size || !size.width || !size.height) return null;
  return quarterTurns % 2 === 1 ? { width: size.height, height: size.width } : size;
}

/** `width` × `height` fitted into `max` (never upscaled, sides ≥ 1). */
export function fitBox(width: number, height: number, max: number): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Whether a thumbnailer result keeps the expected proportions (≤ 2 % off, ≥ 16 px). */
export function sameShape(got: { width: number; height: number }, want: { width: number; height: number }): boolean {
  if (got.width < 16 || got.height < 16) return false;
  return Math.abs(got.width / got.height - want.width / want.height) <= 0.02 * (want.width / want.height);
}
