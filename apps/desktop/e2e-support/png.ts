import { deflateSync } from 'node:zlib';

/**
 * Minimal deterministic PNG encoder (8-bit RGB, no filtering) for mock fixtures.
 * Same input → byte-identical output (fixed zlib level, no timestamps / metadata chunks).
 */

export type Rgb = readonly [number, number, number];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encodes an image whose pixel colour is given by `pixel(u, v)` with u, v ∈ [0, 1). */
export function encodePng(width: number, height: number, pixel: (u: number, v: number) => Rgb): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x / width, y / height);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Width/height from a PNG header, or null when the bytes are not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** "Card" picture: solid background, a circle and a bar. Resolution-independent (same look at any size). */
export function cardPicture(bg: Rgb, circle: Rgb, bar: Rgb, aspect: number): (u: number, v: number) => Rgb {
  return (u, v) => {
    const dx = (u - 0.3) * aspect;
    const dy = v - 0.45;
    if (dx * dx + dy * dy < 0.2 * 0.2) return circle;
    if (u > 0.55 && u < 0.9 && v > 0.38 && v < 0.52) return bar;
    if (u > 0.55 && u < 0.78 && v > 0.58 && v < 0.66) return bar;
    return bg;
  };
}

/** Avatar picture: background with a centred "head and shoulders" silhouette. */
export function avatarPicture(bg: Rgb, fg: Rgb): (u: number, v: number) => Rgb {
  return (u, v) => {
    const hx = u - 0.5;
    const hy = v - 0.38;
    if (hx * hx + hy * hy < 0.17 * 0.17) return fg;
    const bx = (u - 0.5) / 0.34;
    const by = (v - 1.02) / 0.4;
    if (bx * bx + by * by < 1) return fg;
    return bg;
  };
}
