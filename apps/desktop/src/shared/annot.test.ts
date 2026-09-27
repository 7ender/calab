import { describe, expect, it } from 'vitest';
import { displayBoundsFor, overlaySupported, parseOverlayEvent, parseOverlayTarget } from './annot';

const ok = { from: 'u:s', name: 'Анна', kind: 'stroke', color: 0xff0000, points: [0.1, 0.2], strokeId: 3, strokeEnd: false, owner: false };

describe('annot overlay IPC', () => {
  it('accepts a well-formed event', () => {
    expect(parseOverlayEvent(ok)).toEqual(ok);
  });

  it('rejects anything off-shape', () => {
    for (const bad of [
      null,
      'x',
      { ...ok, kind: 'policy' },
      { ...ok, points: [0.1] },
      { ...ok, points: [0.1, 2] },
      { ...ok, points: ['0.1', 0.2] },
      { ...ok, points: new Array<number>(122).fill(0.5) },
      { ...ok, color: -1 },
      { ...ok, color: 1.5 },
      { ...ok, name: 'x'.repeat(201) },
      { ...ok, owner: 'yes' },
    ]) {
      expect(() => parseOverlayEvent(bad)).toThrow();
    }
    expect(() => parseOverlayTarget({ sourceId: 'screen:1:0' })).toThrow();
    expect(parseOverlayTarget({ sourceId: 'screen:1:0', displayId: '1' })).toEqual({ sourceId: 'screen:1:0', displayId: '1' });
  });

  it('covers only whole screens, on a display that exists', () => {
    const displays = [
      { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } },
      { id: 2, bounds: { x: 1512, y: -200, width: 2560, height: 1440 } },
    ];
    expect(displayBoundsFor({ sourceId: 'screen:2:0', displayId: '2' }, displays)).toEqual(displays[1]?.bounds);
    expect(displayBoundsFor({ sourceId: 'window:1234:0', displayId: '' }, displays)).toBeNull();
    expect(displayBoundsFor({ sourceId: 'screen:3:0', displayId: '3' }, displays)).toBeNull();
    expect(displayBoundsFor({ sourceId: 'fake:screen:1', displayId: '1' }, displays)).toBeNull();
  });

  it('only where content protection keeps the overlay out of the capture', () => {
    expect(overlaySupported('darwin')).toBe(true);
    expect(overlaySupported('win32')).toBe(true);
    expect(overlaySupported('linux')).toBe(false);
  });
});
