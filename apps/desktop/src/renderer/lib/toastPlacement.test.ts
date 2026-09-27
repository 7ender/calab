import { describe, expect, it } from 'vitest';
import { toastPlacement } from './toastPlacement';

const viewport = { width: 1280, height: 820 };

describe('toastPlacement', () => {
  it('phone layout: null (CSS keeps the stack under the top bar)', () => {
    expect(toastPlacement({ mobile: true, anchor: { left: 0, right: 390, bottom: 800 }, viewport, composer: 64 })).toBeNull();
  });

  it('desktop: bottom-centre of the chat column, 16 px above the composer, ≤ 480 wide', () => {
    // rail 64 + rooms 240 | chat 304..1040 | members 240.
    expect(toastPlacement({ mobile: false, anchor: { left: 304, right: 1040, bottom: 820 }, viewport, composer: 64 })).toEqual({
      centerX: 672,
      bottom: 80,
      width: 480,
    });
  });

  it('narrow column: width = column − 2 × 16', () => {
    expect(toastPlacement({ mobile: false, anchor: { left: 304, right: 704, bottom: 800 }, viewport, composer: 100 })).toEqual({
      centerX: 504,
      bottom: 136,
      width: 368,
    });
  });

  it('no chat column: bottom-centre of the window', () => {
    expect(toastPlacement({ mobile: false, anchor: null, viewport, composer: 64 })).toEqual({ centerX: 640, bottom: 16, width: 480 });
  });
});
