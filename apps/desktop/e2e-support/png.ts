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

/**
 * Avatar picture (a user-chosen image, not the letter default): a diagonal dusk gradient with a
 * soft sun and two hill layers, 4× supersampled so the edges are smooth. `size` = the pixel
 * width it will be encoded at (for the supersampling step).
 */
export function avatarPicture(from: Rgb, to: Rgb, size = 128): (u: number, v: number) => Rgb {
  const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const sun: Rgb = [255, 226, 170];
  const far: Rgb = mix(to, [20, 24, 48], 0.45);
  const near: Rgb = mix(to, [12, 14, 30], 0.75);
  const sample = (u: number, v: number): Rgb => {
    const back = mix(from, to, Math.min(1, Math.max(0, (u * 0.35 + v * 0.65) * 1.05)));
    if (v > 0.74 + 0.07 * Math.sin(u * 5.2 + 0.4)) return near;
    if (v > 0.62 + 0.09 * Math.sin(u * 3.4 + 2.1)) return far;
    const dx = u - 0.64;
    const dy = v - 0.5;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.16) return sun;
    // Glow around the sun, fading into the sky.
    return d < 0.34 ? mix(back, sun, ((0.34 - d) / 0.18) ** 2 * 0.35) : back;
  };
  const h = 1 / size / 4;
  return (u, v) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const [du, dv] of [
      [h, h],
      [3 * h, h],
      [h, 3 * h],
      [3 * h, 3 * h],
    ] as const) {
      const c = sample(u + du, v + dv);
      r += c[0];
      g += c[1];
      b += c[2];
    }
    return [Math.round(r / 4), Math.round(g / 4), Math.round(b / 4)];
  };
}
