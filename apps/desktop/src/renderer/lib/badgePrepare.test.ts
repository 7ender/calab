import { describe, expect, it, vi } from 'vitest';
import { BADGE_MAX_BYTES, BADGE_SIDE, prepareBadge, squareCrop } from './badgePrepare';
import type { StickerCodec } from './stickerPrepare';

const webp = (size: number): Blob => new Blob([new Uint8Array(size)], { type: 'image/webp' });

function fakeCodec(width: number, height: number, sizes: number[] = [2000]) {
  let i = 0;
  const encode = vi.fn((_w: number, _h: number, _q: number, _crop?: unknown) => Promise.resolve<Blob | null>(webp(sizes[Math.min(i++, sizes.length - 1)] ?? 0)));
  const close = vi.fn();
  const codec: StickerCodec = { decode: () => Promise.resolve({ width, height, encode, close }) };
  return { codec, encode, close };
}

describe('squareCrop', () => {
  it('keeps the centred square of the shorter side', () => {
    expect(squareCrop(300, 100)).toEqual({ sx: 100, sy: 0, sw: 100, sh: 100 });
    expect(squareCrop(100, 301)).toEqual({ sx: 0, sy: 100, sw: 100, sh: 100 });
    expect(squareCrop(64, 64)).toEqual({ sx: 0, sy: 0, sw: 64, sh: 64 });
  });
});

describe('prepareBadge', () => {
  it('crops to a square and draws it at 64×64 WebP', async () => {
    const c = fakeCodec(1200, 800);
    const file = Object.assign(new Blob([new Uint8Array(10)], { type: 'image/png' }), { name: 'acme logo.png' });
    expect(await prepareBadge(file, c.codec)).toMatchObject({ ok: true, name: 'acme logo.webp' });
    expect(c.encode).toHaveBeenCalledWith(BADGE_SIDE, BADGE_SIDE, 0.92, { sx: 200, sy: 0, sw: 800, sh: 800 });
    expect(c.close).toHaveBeenCalled();
  });

  it('steps the quality down until it fits 128 KB, else refuses', async () => {
    const fits = fakeCodec(64, 64, [BADGE_MAX_BYTES + 1, BADGE_MAX_BYTES]);
    expect((await prepareBadge(new Blob([]), fits.codec)).ok).toBe(true);
    expect(fits.encode).toHaveBeenCalledTimes(2);
    const heavy = fakeCodec(64, 64, [BADGE_MAX_BYTES + 1]);
    expect(await prepareBadge(new Blob([]), heavy.codec)).toEqual({ ok: false, reason: 'tooHeavy' });
  });

  it('refuses what does not open as a picture', async () => {
    expect(await prepareBadge(new Blob([]), { decode: () => Promise.resolve(null) })).toEqual({ ok: false, reason: 'broken' });
  });
});
