import { describe, expect, it, vi } from 'vitest';
import {
  QUALITY_STEPS,
  STICKER_MAX_STATIC,
  encodeWithinLimit,
  fitWithin,
  planSticker,
  prepareSticker,
  sniffImage,
  stickerFileKind,
  webpName,
  type StickerCodec,
} from './stickerPrepare';

const le = (n: number, bytes: number): number[] => Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 0xff);
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const chunk = (id: string, payload: number[]): number[] => [...ascii(id), ...le(payload.length, 4), ...payload, ...(payload.length % 2 ? [0] : [])];
const riff = (chunks: number[]): Uint8Array<ArrayBuffer> => new Uint8Array([...ascii('RIFF'), ...le(chunks.length + 4, 4), ...ascii('WEBP'), ...chunks]);

/** An extended WebP: VP8X canvas `w`×`h`, optionally animated (flag + ANIM + one ANMF). */
function webpX(w: number, h: number, animated: boolean): Uint8Array<ArrayBuffer> {
  const vp8x = chunk('VP8X', [animated ? 0x02 : 0, 0, 0, 0, ...le(w - 1, 3), ...le(h - 1, 3)]);
  return riff([...vp8x, ...(animated ? [...chunk('ANIM', [0, 0, 0, 0, 0, 0]), ...chunk('ANMF', new Array<number>(16).fill(0))] : [])]);
}
/** A simple lossless WebP (VP8L) of `w`×`h`. */
function webpL(w: number, h: number): Uint8Array<ArrayBuffer> {
  const v = ((w - 1) | ((h - 1) << 14)) >>> 0;
  return riff(chunk('VP8L', [0x2f, ...le(v, 4)]));
}
function png(w: number, h: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...le(13, 4).reverse(), ...ascii('IHDR'), ...le(w, 4).reverse(), ...le(h, 4).reverse(), 8, 6, 0, 0, 0]);
}

describe('sniffImage', () => {
  it('reads WebP canvas and animation', () => {
    expect(sniffImage(webpX(1024, 1024, false))).toEqual({ kind: 'webp', width: 1024, height: 1024, animated: false });
    expect(sniffImage(webpX(512, 300, true))).toEqual({ kind: 'webp', width: 512, height: 300, animated: true });
    expect(sniffImage(webpL(200, 100))).toMatchObject({ kind: 'webp', width: 200, height: 100, animated: false });
  });
  it('detects an ANIM chunk even without the VP8X flag', () => {
    const b = webpX(100, 100, true);
    b[20] = 0; // clear the animation flag
    expect(sniffImage(b).animated).toBe(true);
  });
  it('recognizes PNG, JPEG, GIF by magic bytes, not by name', () => {
    expect(sniffImage(png(1024, 768))).toEqual({ kind: 'png', width: 1024, height: 768, animated: false });
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])).kind).toBe('jpeg');
    expect(sniffImage(new Uint8Array(ascii('GIF89a\0\0'))).kind).toBe('gif');
    expect(sniffImage(new Uint8Array(ascii('<html></html>'))).kind).toBe('other');
  });
});

describe('stickerFileKind', () => {
  it('filters drops by extension or MIME', () => {
    expect(stickerFileKind('a.WEBP', '')).toBe('webp');
    expect(stickerFileKind('a.jpeg', '')).toBe('jpeg');
    expect(stickerFileKind('x', 'image/png')).toBe('png');
    expect(stickerFileKind('a.gif', 'image/gif')).toBe('gif');
    expect(stickerFileKind('a.heic', '')).toBe('other');
  });
});

describe('fitWithin', () => {
  it('scales the longer side to 512, keeps proportions, never upscales', () => {
    expect(fitWithin(1024, 1024)).toEqual({ width: 512, height: 512 });
    expect(fitWithin(2000, 1000)).toEqual({ width: 512, height: 256 });
    expect(fitWithin(300, 1200)).toEqual({ width: 128, height: 512 });
    expect(fitWithin(200, 100)).toEqual({ width: 200, height: 100 });
    expect(fitWithin(5000, 1)).toEqual({ width: 512, height: 1 });
  });
});

describe('planSticker', () => {
  const still = (w: number, h: number) => ({ kind: 'webp' as const, width: w, height: h, animated: false });
  it('keeps a still WebP within the limits', () => {
    expect(planSticker(still(512, 512), 100_000)).toEqual({ do: 'keep' });
  });
  it('scales down a still WebP / PNG / JPEG larger than 512 (the owner case: 1024×1024)', () => {
    expect(planSticker(still(1024, 1024), 300_000)).toEqual({ do: 'encode', width: 512, height: 512, scaled: true });
    expect(planSticker({ kind: 'png', width: 1024, height: 512, animated: false }, 1)).toEqual({ do: 'encode', width: 512, height: 256, scaled: true });
  });
  it('re-encodes a heavy still WebP and converts a small PNG / JPEG without scaling', () => {
    expect(planSticker(still(400, 400), STICKER_MAX_STATIC + 1)).toEqual({ do: 'encode', width: 400, height: 400, scaled: false });
    expect(planSticker({ kind: 'jpeg', width: 256, height: 256, animated: false }, 1)).toEqual({ do: 'encode', width: 256, height: 256, scaled: false });
  });
  it('never touches an animated WebP: fits → keep, else a refusal', () => {
    const anim = (w: number, h: number) => ({ kind: 'webp' as const, width: w, height: h, animated: true });
    expect(planSticker(anim(512, 512), 900_000)).toEqual({ do: 'keep' });
    expect(planSticker(anim(1024, 1024), 900_000)).toEqual({ do: 'reject', reason: 'animatedTooBig' });
    expect(planSticker(anim(512, 512), 1024 * 1024 + 1)).toEqual({ do: 'reject', reason: 'animatedTooBig' });
  });
  it('refuses GIF, unknown files and unreadable headers', () => {
    expect(planSticker({ kind: 'gif', width: 0, height: 0, animated: false }, 1)).toEqual({ do: 'reject', reason: 'gif' });
    expect(planSticker({ kind: 'other', width: 0, height: 0, animated: false }, 1)).toEqual({ do: 'reject', reason: 'unsupported' });
    expect(planSticker(still(0, 0), 1)).toEqual({ do: 'reject', reason: 'broken' });
  });
});

describe('encodeWithinLimit', () => {
  const blob = (size: number, type = 'image/webp'): Blob => new Blob([new Uint8Array(size)], { type });
  it('stops at the first quality that fits', async () => {
    const encode = vi.fn((q: number) => Promise.resolve(blob(q > 0.8 ? 600 : 400)));
    const out = await encodeWithinLimit(encode, 500);
    expect(out).toBeInstanceOf(Blob);
    expect(encode.mock.calls.map((c) => c[0])).toEqual([0.92, 0.85, 0.78]);
  });
  it('gives up below 0.7', async () => {
    const encode = vi.fn(() => Promise.resolve(blob(1000)));
    expect(await encodeWithinLimit(encode, 500)).toBe('tooHeavy');
    expect(encode).toHaveBeenCalledTimes(QUALITY_STEPS.length);
    expect(QUALITY_STEPS.at(-1)).toBe(0.7);
  });
  it('reports a browser without WebP encoding', async () => {
    expect(await encodeWithinLimit(() => Promise.resolve(blob(10, 'image/png')))).toBe('noEncoder');
    expect(await encodeWithinLimit(() => Promise.resolve(null))).toBe('noEncoder');
  });
});

describe('prepareSticker', () => {
  const file = (bytes: Uint8Array<ArrayBuffer>, name: string, type = ''): File => new File([bytes], name, { type });
  const codec = (w: number, h: number, out = 1000): StickerCodec & { calls: Array<[number, number, number]> } => {
    const calls: Array<[number, number, number]> = [];
    return {
      calls,
      decode: () =>
        Promise.resolve({
          width: w,
          height: h,
          encode: (ew: number, eh: number, q: number) => {
            calls.push([ew, eh, q]);
            return Promise.resolve(new Blob([new Uint8Array(out)], { type: 'image/webp' }));
          },
          close: () => {},
        }),
    };
  };
  it('scales a 1024×1024 PNG down to a 512×512 WebP', async () => {
    const c = codec(1024, 1024);
    const r = await prepareSticker(file(png(1024, 1024), 'cat.png', 'image/png'), c);
    expect(r).toMatchObject({ ok: true, sticker: { name: 'cat.webp', width: 512, height: 512, size: 1000, scaled: true, animated: false } });
    expect(c.calls).toEqual([[512, 512, 0.92]]);
  });
  it('passes a small still WebP as is, without decoding', async () => {
    const c = codec(0, 0);
    const decode = vi.spyOn(c, 'decode');
    const f = file(webpL(128, 128), 'a.webp');
    const r = await prepareSticker(f, c);
    expect(r).toMatchObject({ ok: true, sticker: { blob: f, width: 128, height: 128, scaled: false } });
    expect(decode).not.toHaveBeenCalled();
  });
  it('refuses an oversized animated WebP and a GIF', async () => {
    expect(await prepareSticker(file(webpX(1024, 1024, true), 'a.webp'), codec(0, 0))).toMatchObject({ ok: false, reason: 'animatedTooBig', sniff: { animated: true, width: 1024 } });
    expect(await prepareSticker(file(new Uint8Array(ascii('GIF89a\0\0\0\0')), 'a.gif'), codec(0, 0))).toMatchObject({ ok: false, reason: 'gif' });
  });
  it('reports a file that does not decode', async () => {
    expect(await prepareSticker(file(png(10, 10), 'a.png'), { decode: () => Promise.resolve(null) })).toEqual({ ok: false, reason: 'broken' });
  });
  it('names the result .webp', () => {
    expect(webpName('Photo 1.JPG')).toBe('Photo 1.webp');
    expect(webpName('noext')).toBe('noext.webp');
    expect(webpName('.png')).toBe('sticker.webp');
  });
});
