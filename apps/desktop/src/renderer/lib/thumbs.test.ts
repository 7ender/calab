import { describe, expect, it } from 'vitest';
import { densitySrcSet, pickByDensity, thumbSize, thumbWidthPath, wantsLargeThumb } from './thumbs';

describe('thumbSize (mirrors the server FitSize)', () => {
  it('fits the longer side, never upscales', () => {
    expect(thumbSize(2000, 1000, 512)).toEqual({ w: 512, h: 256 });
    expect(thumbSize(300, 3000, 512)).toEqual({ w: 51, h: 512 });
    expect(thumbSize(800, 300, 1024)).toEqual({ w: 800, h: 300 });
  });
});

describe('wantsLargeThumb', () => {
  it('asks for 1024 when a wide bubble would enlarge the 512 thumbnail on 2×', () => {
    expect(wantsLargeThumb(4000, 3000, 420, 315)).toBe(true);
    expect(wantsLargeThumb(1200, 600, 420, 210)).toBe(true);
  });

  it('keeps 512 for boxes up to 260 CSS px (album cells) even on 2×', () => {
    expect(wantsLargeThumb(4000, 3000, 209, 209)).toBe(false);
    expect(wantsLargeThumb(4000, 3000, 260, 195)).toBe(false);
    expect(wantsLargeThumb(4000, 3000, 261, 196)).toBe(true);
  });

  it('keeps 512 when the original fits it (the 1024 one would be the same picture)', () => {
    expect(wantsLargeThumb(500, 400, 420, 336)).toBe(false);
    expect(wantsLargeThumb(512, 512, 420, 420)).toBe(false);
  });

  it('judges portraits by the drawn width, not the box width alone', () => {
    // 1000×2000 → 256×512 thumbnail; a 230×460 box on 2× needs 460 px wide.
    expect(wantsLargeThumb(1000, 2000, 230, 460)).toBe(true);
  });

  it('decides by the box when the image size is unknown', () => {
    expect(wantsLargeThumb(undefined, undefined, 320, 240)).toBe(true);
    expect(wantsLargeThumb(0, 0, 200, 150)).toBe(false);
  });
});

describe('srcset helpers', () => {
  const p = '/api/files/f1/thumbnail';
  it('builds the 1x/2x srcset for direct URLs', () => {
    expect(densitySrcSet(p, thumbWidthPath(p, 1024))).toBe('/api/files/f1/thumbnail 1x, /api/files/f1/thumbnail?w=1024 2x');
  });
  it('picks by DPR where srcset cannot be used (web)', () => {
    expect(pickByDensity('s', 'l', 1)).toBe('s');
    expect(pickByDensity('s', 'l', 1.25)).toBe('s');
    expect(pickByDensity('s', 'l', 1.5)).toBe('l');
    expect(pickByDensity('s', 'l', 3)).toBe('l');
  });
});
