import { describe, expect, it } from 'vitest';
import { CHECK, CHECK_TOTAL_MS, analyseEchoCheck, patternFrames, testSignal } from './echoCheck';

const frames = Math.round(CHECK_TOTAL_MS / CHECK.frameMs);
const pattern = patternFrames();
const warm = CHECK.warmupMs / CHECK.frameMs;

/** Mic levels: noise floor, plus the bursts coming back `lagFrames` later at `returnDb`. */
function recording(returnDb: number | null, lagFrames: number, floorDb = -62): number[] {
  const out: number[] = [];
  for (let k = 0; k < frames; k++) {
    const i = k - lagFrames;
    const burst = i < warm ? i >= 0 : pattern[i - warm] === true;
    const jitter = ((k * 7919) % 13) / 13 - 0.5; // deterministic ±0.5 dB
    out.push(returnDb !== null && burst ? returnDb + jitter : floorDb + jitter);
  }
  return out;
}

describe('analyseEchoCheck', () => {
  it('nothing comes back (headphones / AEC works) → none', () => {
    expect(analyseEchoCheck(recording(null, 0), -50).level).toBe('none');
  });

  it('a faint return, below −65 dBFS → none', () => {
    expect(analyseEchoCheck(recording(-66, 4, -75), -50).level).toBe('none');
  });

  it('a return clearly above the floor but under the gate → weak', () => {
    const r = analyseEchoCheck(recording(-54, 5), -50);
    expect(r.level).toBe('weak');
    expect(r.lagMs).toBe(100);
  });

  it('a loud return that would open the gate → strong, lag found', () => {
    const r = analyseEchoCheck(recording(-35, 8), -50);
    expect(r.level).toBe('strong');
    expect(r.lagMs).toBe(160);
    expect(r.deltaDb).toBeGreaterThan(20);
    expect(r.corr).toBeGreaterThan(0.9);
  });

  it('loud noise unrelated to the bursts (someone talking) is not echo', () => {
    const noisy = Array.from({ length: frames }, (_, k) => (Math.floor(k / 17) % 2 ? -30 : -60));
    expect(analyseEchoCheck(noisy, -50).level).not.toBe('strong');
  });
});

describe('testSignal', () => {
  it('is short and quiet: ≈ 3 s, RMS −28 dBFS, no clipping', () => {
    const s = testSignal();
    expect(s.length / CHECK.sampleRate).toBeCloseTo(3, 1);
    let peak = 0;
    for (const v of s) peak = Math.max(peak, Math.abs(v));
    // RMS while sounding: the warm-up second (minus the fades).
    const warmup = s.subarray(CHECK.sampleRate * 0.01, CHECK.sampleRate * 0.99);
    const sq = warmup.reduce((a, v) => a + v * v, 0);
    expect(20 * Math.log10(Math.sqrt(sq / warmup.length))).toBeCloseTo(CHECK.levelDb, 0);
    expect(peak).toBeLessThan(0.5);
  });

  it('is silent in the pattern gaps', () => {
    const s = testSignal();
    const gapStart = ((CHECK.warmupMs + 200 + 50) / 1000) * CHECK.sampleRate; // inside the first gap
    expect(Math.abs(s[Math.round(gapStart)] ?? 1)).toBe(0);
  });
});
