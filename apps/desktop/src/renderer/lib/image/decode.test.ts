import { describe, expect, it, vi } from 'vitest';
import { decodeImage, decodeLadder, namedHeif, sniffHeif, type DecodeDeps, type Decoded } from './decode';
import { ImageError } from './errors';

const ftyp = (...brands: string[]): Uint8Array => {
  const head = [0, 0, 0, 8 + 4 * brands.length, ...'ftyp'.split('').map((c) => c.charCodeAt(0))];
  for (const b of brands) for (const c of b) head.push(c.charCodeAt(0));
  return new Uint8Array([...head, ...new Array<number>(16).fill(0)]);
};
const heic = (): Blob => new Blob([ftyp('heic', '\0\0\0\0', 'mif1', 'heic')], { type: '' });
const png = (): Blob => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(24).fill(0)])], { type: 'image/png' });

const img = (w = 10, h = 10): Decoded => ({ width: w, height: h, close: vi.fn() });

describe('sniffHeif', () => {
  it('knows HEIF brands and leaves AVIF / MP4 / JPEG alone', () => {
    expect(sniffHeif(ftyp('heic', '\0\0\0\0', 'mif1', 'heic'))).toBe(true);
    expect(sniffHeif(ftyp('mif1', '\0\0\0\0', 'mif1', 'heix'))).toBe(true);
    expect(sniffHeif(ftyp('avif', '\0\0\0\0', 'avif', 'mif1'))).toBe(false);
    expect(sniffHeif(ftyp('mif1', '\0\0\0\0', 'mif1', 'avif'))).toBe(false);
    expect(sniffHeif(ftyp('isom', '\0\0\x02\0', 'isom', 'mp41'))).toBe(false);
    expect(sniffHeif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(20).fill(0)]))).toBe(false);
    expect(sniffHeif(new Uint8Array(4))).toBe(false);
  });

  it('names and types', () => {
    expect(namedHeif('IMG_0001.HEIC', '')).toBe(true);
    expect(namedHeif('a.heif', '')).toBe(true);
    expect(namedHeif('photo', 'image/heic')).toBe(true);
    expect(namedHeif('photo.jpg', 'image/jpeg')).toBe(false);
  });
});

describe('decodeLadder', () => {
  it('HEIF: browser → OS (Electron) → server; anything else: the browser only', () => {
    expect(decodeLadder(true, { native: true, server: true })).toEqual(['bitmap', 'native', 'server']);
    expect(decodeLadder(true, { native: false, server: true })).toEqual(['bitmap', 'server']);
    expect(decodeLadder(true, { native: false, server: false })).toEqual(['bitmap']);
    expect(decodeLadder(false, { native: true, server: true })).toEqual(['bitmap']);
  });
});

describe('decodeImage', () => {
  const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });

  it('a picture the browser opens never leaves it', async () => {
    const out = img();
    const deps: DecodeDeps<Decoded> = { bitmap: vi.fn(() => Promise.resolve(out)), native: vi.fn(), server: vi.fn() };
    expect(await decodeImage(png(), 'a.png', deps)).toBe(out);
    expect(deps.native).not.toHaveBeenCalled();
    expect(deps.server).not.toHaveBeenCalled();
  });

  it('HEIC in Electron on macOS: the OS decodes it, the server is not asked', async () => {
    const out = img(4032, 3024);
    const bitmap = vi.fn((b: Blob) => Promise.resolve(b === jpeg ? out : null));
    const deps: DecodeDeps<Decoded> = { bitmap, native: vi.fn(() => Promise.resolve(jpeg)), server: vi.fn() };
    expect(await decodeImage(heic(), 'IMG.HEIC', deps)).toBe(out);
    expect(deps.native).toHaveBeenCalledWith(expect.any(Blob), 4096);
    expect(deps.server).not.toHaveBeenCalled();
  });

  it('HEIC on Linux / Windows without the codec / the web: the server converts it', async () => {
    const out = img();
    const bitmap = vi.fn((b: Blob) => Promise.resolve(b === jpeg ? out : null));
    const server = vi.fn(() => Promise.resolve(jpeg));
    expect(await decodeImage(heic(), 'IMG.HEIC', { bitmap, native: () => Promise.resolve(null), server })).toBe(out);
    expect(server).toHaveBeenCalledWith(expect.any(Blob), 'IMG.HEIC');
    expect(await decodeImage(heic(), 'IMG.HEIC', { bitmap, server })).toBe(out);
  });

  it('HEIC nobody can open: heicUnsupported; a broken PNG: broken (not sent to the server)', async () => {
    const none = { bitmap: () => Promise.resolve(null), native: () => Promise.resolve(null), server: vi.fn(() => Promise.resolve(null)) };
    await expect(decodeImage(heic(), 'x.heic', none)).rejects.toEqual(new ImageError('heicUnsupported'));
    await expect(decodeImage(png(), 'x.png', none)).rejects.toEqual(new ImageError('broken'));
    expect(none.server).toHaveBeenCalledTimes(1);
  });

  it('a network failure of the server rung surfaces as it is', async () => {
    const boom = new Error('offline');
    const deps = { bitmap: () => Promise.resolve(null), server: () => Promise.reject(boom) };
    await expect(decodeImage(heic(), 'x.heic', deps)).rejects.toBe(boom);
  });
});
