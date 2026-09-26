import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, SOUNDS, SOUND_EVENTS, durationMs, synth } from './sounds';

describe('event sounds', () => {
  it('every event has a sound of at most 300 ms (docs/09 #29)', () => {
    for (const name of SOUND_EVENTS) {
      expect(SOUNDS[name].length).toBeGreaterThan(0);
      expect(durationMs(name)).toBeLessThanOrEqual(300);
    }
  });

  it('synthesises click-free PCM within the headroom', () => {
    for (const name of SOUND_EVENTS) {
      const pcm = synth(SOUNDS[name]);
      expect(Math.abs(pcm.length - (durationMs(name) / 1000) * SAMPLE_RATE)).toBeLessThanOrEqual(2);
      let peak = 0;
      for (const v of pcm) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeGreaterThan(1000);
      expect(peak).toBeLessThanOrEqual(Math.round(0.32 * 32767));
      // Starts and ends silent (attack / release ramps).
      expect(Math.abs(pcm[0] ?? 1)).toBe(0);
      expect(Math.abs(pcm[pcm.length - 1] ?? 1)).toBeLessThan(200);
    }
  });
});
