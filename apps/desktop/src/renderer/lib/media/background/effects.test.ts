import { describe, expect, it } from 'vitest';
import {
  DARK_OFF,
  DARK_ON,
  DEFAULT_CAMERA_EFFECTS,
  DENOISE_MAX,
  EXPOSURE_TARGET,
  GAMMA_MIN,
  TOUCH_UP_MAX,
  denoiseAmount,
  effectsActive,
  exposureDecision,
  exposureRamp,
  histogramMean,
  lumaHistogram,
  touchUpAmount,
  touchUpRange,
  workerEffects,
} from './effects';

describe('touch-up strength mapping', () => {
  it('0 is off, 100 is the cap, the default is gentle', () => {
    expect(touchUpAmount(0)).toBe(0);
    expect(touchUpAmount(100)).toBeCloseTo(TOUCH_UP_MAX);
    const d = touchUpAmount(DEFAULT_CAMERA_EFFECTS.touchUpStrength);
    expect(d).toBeGreaterThan(0.45);
    expect(d).toBeLessThan(0.6);
  });

  it('is monotonic and clamps junk', () => {
    let prev = -1;
    for (let s = 0; s <= 100; s += 5) {
      const a = touchUpAmount(s);
      expect(a).toBeGreaterThan(prev);
      prev = a;
    }
    expect(touchUpAmount(-10)).toBe(0);
    expect(touchUpAmount(250)).toBeCloseTo(TOUCH_UP_MAX);
    expect(touchUpAmount(Number.NaN)).toBe(0);
  });

  it('the bilateral range widens with strength but stays under feature contrast', () => {
    expect(touchUpRange(0)).toBeLessThan(touchUpRange(100));
    expect(touchUpRange(100)).toBeLessThanOrEqual(0.1);
  });

  it('worker effects: touch-up off sends 0, the switch is passed as is', () => {
    expect(workerEffects({ touchUp: false, touchUpStrength: 80, lowLight: true })).toEqual({ touchUp: 0, touchRange: 0, lowLight: true });
    const on = workerEffects({ touchUp: true, touchUpStrength: 40, lowLight: false });
    expect(on.touchUp).toBeCloseTo(touchUpAmount(40));
    expect(on.touchRange).toBeCloseTo(touchUpRange(40));
  });

  it('a processor is needed only for an effect that does something', () => {
    expect(effectsActive(DEFAULT_CAMERA_EFFECTS)).toBe(false);
    expect(effectsActive({ touchUp: true, touchUpStrength: 0, lowLight: false })).toBe(false);
    expect(effectsActive({ touchUp: true, touchUpStrength: 1, lowLight: false })).toBe(true);
    expect(effectsActive({ touchUp: false, touchUpStrength: 40, lowLight: true })).toBe(true);
  });
});

describe('low-light meter', () => {
  const frame = (y: number, n = 100): Uint8Array => new Uint8Array(n * 4).map((_, i) => (i % 4 === 3 ? 255 : y));

  it('histogram and mean of a flat frame', () => {
    const h = lumaHistogram(frame(64));
    expect(h[64]).toBe(100);
    expect(histogramMean(h)).toBeCloseTo(64 / 255);
    expect(histogramMean(new Uint32Array(256))).toBe(0);
  });

  it('mean of a mixed frame weighs by pixel count', () => {
    const a = frame(0, 3);
    const b = frame(255, 1);
    const both = new Uint8Array([...a, ...b]);
    expect(histogramMean(lumaHistogram(both))).toBeCloseTo(0.25);
  });
});

describe('exposure decision', () => {
  it('a dark room is lifted towards the target, never past gamma 1', () => {
    const d = exposureDecision(0.2, false);
    expect(d.active).toBe(true);
    expect(d.gamma).toBeLessThan(1);
    expect(d.gamma).toBeGreaterThanOrEqual(GAMMA_MIN);
    // The mean lands on the target (that is how gamma is chosen).
    expect(0.2 ** d.gamma).toBeCloseTo(EXPOSURE_TARGET);
  });

  it('a bright room is never touched', () => {
    for (const m of [DARK_ON, 0.45, 0.7, 1]) expect(exposureDecision(m, false)).toEqual({ active: false, gamma: 1 });
    expect(exposureDecision(0.95, true)).toEqual({ active: false, gamma: 1 });
  });

  it('hysteresis: between the thresholds the previous state holds', () => {
    const mid = (DARK_ON + DARK_OFF) / 2;
    expect(exposureDecision(mid, false).active).toBe(false);
    const on = exposureDecision(mid, true);
    expect(on.active).toBe(true);
    expect(on.gamma).toBeLessThan(1);
    expect(exposureDecision(DARK_OFF, true).active).toBe(false);
  });

  it('very dark: the curve is capped; a black frame (covered lens) is left alone', () => {
    expect(exposureDecision(0.05, false).gamma).toBe(GAMMA_MIN);
    expect(exposureDecision(0.005, false)).toEqual({ active: false, gamma: 1 });
    expect(exposureDecision(Number.NaN, true)).toEqual({ active: false, gamma: 1 });
  });

  it('the curve ramps smoothly and snaps back to exactly 1', () => {
    let g = 1;
    g = exposureRamp(g, 0.6, 67);
    expect(g).toBeLessThan(1);
    expect(g).toBeGreaterThan(0.9);
    for (let i = 0; i < 60; i++) g = exposureRamp(g, 0.6, 67);
    expect(g).toBeCloseTo(0.6, 2);
    for (let i = 0; i < 120; i++) g = exposureRamp(g, 1, 67);
    expect(g).toBe(1);
  });

  it('denoise follows the lift', () => {
    expect(denoiseAmount(1)).toBe(0);
    expect(denoiseAmount(GAMMA_MIN)).toBeCloseTo(DENOISE_MAX);
    expect(denoiseAmount(0.75)).toBeCloseTo(DENOISE_MAX / 2);
    expect(denoiseAmount(0.1)).toBeCloseTo(DENOISE_MAX);
  });
});
