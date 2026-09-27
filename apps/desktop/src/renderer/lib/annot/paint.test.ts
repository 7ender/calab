import { describe, expect, it } from 'vitest';
import { ANNOT_COLORS, colorFor, contentRect, toFrame, toFrameClamped } from './paint';
import { grantAllowsAnnot } from './permission';

describe('annot geometry', () => {
  it('maps the frame inside a letterboxed element (object-contain)', () => {
    // 16:9 video in a 4:3 box: bars top and bottom.
    expect(contentRect(800, 600, 1920, 1080)).toEqual({ x: 0, y: 75, w: 800, h: 450 });
    // 4:3 video in a 16:9 box: bars left and right.
    expect(contentRect(1600, 900, 1024, 768)).toEqual({ x: 200, y: 0, w: 1200, h: 900 });
    // No frame yet: the whole element.
    expect(contentRect(320, 180, 0, 0)).toEqual({ x: 0, y: 0, w: 320, h: 180 });
  });

  it('normalizes pointer positions to the frame', () => {
    const r = contentRect(800, 600, 1920, 1080);
    expect(toFrame(r, 400, 300)).toEqual([0.5, 0.5]);
    expect(toFrame(r, 400, 30)).toBeNull(); // on the bar
    expect(toFrameClamped(r, 900, 30)).toEqual([1, 0]);
  });

  it('gives every user a stable default colour from the palette, never white', () => {
    expect(colorFor('u1')).toBe(colorFor('u1'));
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      expect(ANNOT_COLORS).toContain(colorFor(id));
      expect(colorFor(id)).not.toBe(0xffffff);
    }
  });
});

describe('annot permission (sender grant)', () => {
  it('needs the microphone source (SPEAK in the room)', () => {
    expect(grantAllowsAnnot(undefined)).toBe(false);
    expect(grantAllowsAnnot({ canPublish: false, canPublishSources: [] })).toBe(false); // listener
    expect(grantAllowsAnnot({ canPublish: true, canPublishSources: [3, 4] })).toBe(false); // screen only
    expect(grantAllowsAnnot({ canPublish: true, canPublishSources: [2] })).toBe(true);
    expect(grantAllowsAnnot({ canPublish: true, canPublishSources: [] })).toBe(true); // all sources
  });
});
