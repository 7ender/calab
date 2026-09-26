import { describe, expect, it } from 'vitest';
import { THUMB_DEFAULT, parseThumbRequest, parseThumbSize, sameThumb, thumbSizeFor } from './captureThumb';

describe('thumbSizeFor (docs/09 #17: previews drawn 1:1)', () => {
  it('asks for the preview box in device pixels, 16:9', () => {
    expect(thumbSizeFor(504, 2)).toEqual({ width: 1008, height: 567 });
    expect(thumbSizeFor(412, 1)).toEqual({ width: 412, height: 232 });
    expect(thumbSizeFor(300, 1.5)).toEqual({ width: 450, height: 253 });
  });
  it('treats a missing / odd devicePixelRatio as 1 and caps it at 4', () => {
    expect(thumbSizeFor(400, 0)).toEqual(thumbSizeFor(400, 1));
    expect(thumbSizeFor(400, Number.NaN)).toEqual(thumbSizeFor(400, 1));
    expect(thumbSizeFor(400, 8)).toEqual(thumbSizeFor(400, 4));
  });
  it('clamps to 16…3840 px wide, falls back before the card is measured', () => {
    expect(thumbSizeFor(2, 1).width).toBe(16);
    expect(thumbSizeFor(5000, 2)).toEqual({ width: 3840, height: 2160 });
    expect(thumbSizeFor(0, 2)).toEqual(THUMB_DEFAULT);
  });
});

describe('parseThumbSize / parseThumbRequest (main validates the renderer)', () => {
  it('clamps numbers and rejects junk', () => {
    expect(parseThumbSize({ width: 1008.4, height: 567 })).toEqual({ width: 1008, height: 567 });
    expect(parseThumbSize({ width: 1e9, height: -5 })).toEqual({ width: 3840, height: 9 });
    expect(parseThumbSize({ width: '1', height: 2 })).toBe(THUMB_DEFAULT);
    expect(parseThumbSize(null)).toBe(THUMB_DEFAULT);
    expect(parseThumbSize({ width: Infinity, height: 2 })).toBe(THUMB_DEFAULT);
    expect(parseThumbRequest(undefined)).toEqual({ screen: THUMB_DEFAULT, window: THUMB_DEFAULT });
    expect(parseThumbRequest({ screen: { width: 100, height: 56 } }).screen).toEqual({ width: 100, height: 56 });
  });
  it('compares sizes', () => {
    expect(sameThumb({ width: 1, height: 2 }, { width: 1, height: 2 })).toBe(true);
    expect(sameThumb({ width: 1, height: 2 }, { width: 2, height: 2 })).toBe(false);
  });
});
