import { describe, expect, it } from 'vitest';
import { FILE_SOUNDS, SAMPLE_RATE, SOUNDS, SOUND_EVENTS, createGate, durationMs, synth } from './sounds';

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

describe('sound rate limit', () => {
  it('a new message sounds at most once per 2 s', () => {
    const gate = createGate();
    expect(gate.allow('message', 0)).toBe(true);
    expect(gate.allow('message', 500)).toBe(false);
    expect(gate.allow('message', 1999)).toBe(false);
    expect(gate.allow('message', 2000)).toBe(true);
    expect(gate.allow('message', 3000)).toBe(false);
  });

  it('events are limited independently; others use the short burst gap', () => {
    const gate = createGate();
    expect(gate.allow('message', 0)).toBe(true);
    expect(gate.allow('mention', 10)).toBe(true);
    expect(gate.allow('join', 20)).toBe(true);
    expect(gate.allow('join', 100)).toBe(false);
    expect(gate.allow('join', 200)).toBe(true);
  });

  it('a forced preview counts as a play', () => {
    const gate = createGate();
    gate.mark('message', 0);
    expect(gate.allow('message', 1000)).toBe(false);
    expect(gate.allow('message', 2000)).toBe(true);
  });
});

describe('bundled message sound', () => {
  it('«message» plays the generated WAV (scripts/gen-sounds.mjs)', () => {
    expect(FILE_SOUNDS.message).toMatch(/message\.wav/);
  });
});
