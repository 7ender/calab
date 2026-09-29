import { describe, expect, it, vi } from 'vitest';
import type { DecodeDeps, Decoded } from './decode';
import { ImageError } from './errors';
import { AVATAR_SIDE, ICON_SIDE, avatarPlan, encodeWebpOrJpeg, prepareAttachment, prepareAvatar, renamed, type Encoder, type OutType } from './prepare';

const blob = (type: string, size = 100): Blob => new Blob([new Uint8Array(size)], { type });
const heic = (): Blob => new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0, 109, 105, 102, 49, 104, 101, 105, 99, ...new Array<number>(16).fill(0)])]);

function fakeImage(width: number, height: number): Decoded {
  return { width, height, close: vi.fn() };
}

/** An encoder that answers WebP unless `webp` is false (then PNG, like Safari < 16). */
function fakeEncoder(webp = true): Encoder<Decoded> & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    encode(_src, crop, w, h, type: OutType, q) {
      calls.push([crop, w, h, type, q]);
      if (type === 'image/webp' && !webp) return Promise.resolve(blob('image/png'));
      return Promise.resolve(blob(type));
    },
  };
}

const deps = (img: Decoded): DecodeDeps<Decoded> => ({ bitmap: () => Promise.resolve(img) });

describe('avatarPlan', () => {
  it('centre square, 512 px, never upscaled', () => {
    expect(avatarPlan(4032, 3024)).toEqual({ crop: { sx: 504, sy: 0, sw: 3024, sh: 3024 }, side: 512 });
    expect(avatarPlan(1080, 1920)).toEqual({ crop: { sx: 0, sy: 420, sw: 1080, sh: 1080 }, side: 512 });
    expect(avatarPlan(200, 300)).toEqual({ crop: { sx: 0, sy: 50, sw: 200, sh: 200 }, side: 200 });
    expect(avatarPlan(1000, 1000, ICON_SIDE).side).toBe(256);
    expect(avatarPlan(1, 1).side).toBe(1);
  });
});

describe('encodeWebpOrJpeg', () => {
  const crop = { sx: 0, sy: 0, sw: 10, sh: 10 };
  it('WebP 0.85 when the browser encodes it', async () => {
    const enc = fakeEncoder();
    expect((await encodeWebpOrJpeg(enc, fakeImage(10, 10), crop, 10, 10)).type).toBe('image/webp');
    expect(enc.calls).toEqual([[crop, 10, 10, 'image/webp', 0.85]]);
  });
  it('JPEG 0.88 when WebP comes back as PNG or null (Safari < 16)', async () => {
    const enc = fakeEncoder(false);
    expect((await encodeWebpOrJpeg(enc, fakeImage(10, 10), crop, 10, 10)).type).toBe('image/jpeg');
    expect(enc.calls[1]).toEqual([crop, 10, 10, 'image/jpeg', 0.88]);
    const none: Encoder<Decoded> = { encode: () => Promise.resolve(null) };
    await expect(encodeWebpOrJpeg(none, fakeImage(10, 10), crop, 10, 10)).rejects.toEqual(new ImageError('noEncoder'));
  });
});

describe('prepareAvatar', () => {
  it('a phone photo → 512×512 WebP named .webp, the bitmap closed', async () => {
    const img = fakeImage(4032, 3024);
    const enc = fakeEncoder();
    const out = await prepareAvatar(blob('image/jpeg', 5_000_000), 'IMG_1234.JPG', AVATAR_SIDE, deps(img), enc);
    expect(out.name).toBe('IMG_1234.webp');
    expect(out.blob.type).toBe('image/webp');
    expect(enc.calls[0]).toEqual([{ sx: 504, sy: 0, sw: 3024, sh: 3024 }, 512, 512, 'image/webp', 0.85]);
    expect(img.close).toHaveBeenCalled();
  });
  it('JPEG fallback keeps the .jpg name', async () => {
    const out = await prepareAvatar(blob('image/png'), 'me.png', AVATAR_SIDE, deps(fakeImage(600, 600)), fakeEncoder(false));
    expect(out.name).toBe('me.jpg');
  });
});

describe('prepareAttachment', () => {
  it('leaves anything but HEIC untouched', async () => {
    const f = blob('image/png');
    const bitmap = vi.fn();
    expect(await prepareAttachment(f, 'shot.png', { bitmap }, fakeEncoder())).toEqual({ blob: f, name: 'shot.png' });
    expect(bitmap).not.toHaveBeenCalled();
  });
  it('HEIC → JPEG 0.9 within 4096 px, named .jpg', async () => {
    const enc = fakeEncoder();
    const img = fakeImage(8064, 6048);
    const out = await prepareAttachment(heic(), 'IMG_0001.HEIC', deps(img), enc);
    expect(out.name).toBe('IMG_0001.jpg');
    expect(enc.calls[0]).toEqual([{ sx: 0, sy: 0, sw: 8064, sh: 6048 }, 4096, 3072, 'image/jpeg', 0.9]);
    expect(img.close).toHaveBeenCalled();
    const small = fakeEncoder();
    await prepareAttachment(heic(), 'a.heic', deps(fakeImage(1200, 900)), small);
    expect(small.calls[0]?.slice(1, 3)).toEqual([1200, 900]);
  });
});

describe('renamed', () => {
  it('swaps the extension', () => {
    expect(renamed('a.b.png', 'image/webp')).toBe('a.b.webp');
    expect(renamed('noext', 'image/jpeg')).toBe('noext.jpg');
    expect(renamed('', 'image/webp', 'avatar')).toBe('avatar.webp');
  });
});
