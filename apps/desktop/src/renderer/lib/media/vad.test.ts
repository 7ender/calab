import { describe, expect, it } from 'vitest';
import { VoiceGate, rmsToDb } from './vad';

const loud = { db: -20, vad: 0.9 };
const quiet = { db: -70, vad: 0.9 };
const noise = { db: -20, vad: 0.1 };

describe('VoiceGate', () => {
  it('opens only after 2 consecutive speech frames', () => {
    const g = new VoiceGate({ thresholdDb: -50 });
    expect(g.push(loud)).toBe(false);
    expect(g.push(quiet)).toBe(false);
    expect(g.push(loud)).toBe(false);
    expect(g.push(loud)).toBe(true);
  });

  it('holds for the 400 ms hangover, then closes', () => {
    const g = new VoiceGate({ thresholdDb: -50 });
    g.push(loud);
    g.push(loud);
    for (let i = 0; i < 19; i++) expect(g.push(quiet)).toBe(true); // 380 ms
    expect(g.push(quiet)).toBe(false); // 400 ms
  });

  it('speech during hangover resets it', () => {
    const g = new VoiceGate({ thresholdDb: -50 });
    g.push(loud);
    g.push(loud);
    for (let i = 0; i < 15; i++) g.push(quiet);
    g.push(loud);
    for (let i = 0; i < 19; i++) expect(g.push(quiet)).toBe(true);
    expect(g.push(quiet)).toBe(false);
  });

  it('requires RNNoise voice probability when available', () => {
    const g = new VoiceGate({ thresholdDb: -50 });
    for (let i = 0; i < 10; i++) expect(g.push(noise)).toBe(false);
  });

  it('falls back to level only when RNNoise is off', () => {
    const g = new VoiceGate({ thresholdDb: -50 });
    g.push({ db: -30, vad: null });
    expect(g.push({ db: -30, vad: null })).toBe(true);
  });
});

describe('rmsToDb', () => {
  it('maps full scale to 0 dB and clamps silence', () => {
    expect(rmsToDb(1)).toBeCloseTo(0);
    expect(rmsToDb(0)).toBe(-80);
  });
});
