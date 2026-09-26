import { describe, expect, it } from 'vitest';
import { DUCK_GAIN, ECHO, EchoRiskDetector, RemoteActivity, bestLagCorrelation, duckWanted, pearson, type EchoFrame, type EchoStats } from './echo';

/** Deterministic PRNG (tests must not flake). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Far-end speech: talk spurts of 0.3–1.5 s with 0.2–0.8 s pauses; level ≈ −26 dBov ± 6 dB. */
function farEnd(frames: number, seed = 1): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let on = true;
  let left = 0;
  while (out.length < frames) {
    if (left <= 0) {
      on = !on;
      left = Math.round((on ? 300 + r() * 1200 : 200 + r() * 600) / ECHO.frameMs);
    }
    out.push(on ? 10 ** ((-26 + (r() - 0.5) * 12) / 20) : 0.001);
    left--;
  }
  return out;
}

interface Scenario {
  seconds: number;
  remote: number[];
  /** Mic dBFS as sent and whether it is on air, per frame. */
  mic: (i: number, remoteActive: boolean) => { db: number; sending: boolean };
  stats?: EchoStats;
}

/** Runs a scenario at 50 ms frames with a 2 s stats tick; returns when (s) the risk turned on. */
function run(s: Scenario, d = new EchoRiskDetector()): number | null {
  const act = new RemoteActivity();
  const n = Math.round((s.seconds * 1000) / ECHO.frameMs);
  for (let i = 0; i < n; i++) {
    const t = i * ECHO.frameMs;
    const remote = s.remote[i] ?? 0;
    const remoteActive = act.push(remote, t);
    const m = s.mic(i, remoteActive);
    const f: EchoFrame = { t, remote, remoteActive, micDb: m.db, sending: m.sending };
    d.pushFrame(f);
    if (t > 0 && t % ECHO.statsMs === 0 && d.evaluate(t, s.stats ?? { erl: null, erle: null })) return t / 1000;
  }
  return null;
}

const db = (level: number): number => 20 * Math.log10(Math.max(level, 1e-4));

describe('EchoRiskDetector — correlation (what the far end actually hears)', () => {
  it('flags echo: what we send follows their voice 150 ms later, 20 dB down, and opens the gate', () => {
    const remote = farEnd(400);
    const lag = 3;
    const at = run({
      seconds: 20,
      remote,
      mic: (i) => {
        const echo = db(remote[i - lag] ?? 0) - 20;
        return { db: echo, sending: echo > -55 };
      },
    });
    expect(at).not.toBeNull();
    // Two full bad windows: not before ~6 s, well within 12 s.
    expect(at ?? -1).toBeGreaterThanOrEqual(6);
    expect(at ?? -1).toBeLessThanOrEqual(12);
  });

  it('headphones: the gate stays closed while they talk → nothing leaks', () => {
    expect(run({ seconds: 20, remote: farEnd(400), mic: () => ({ db: -70, sending: false }) })).toBeNull();
  });

  it('double talk: we speak independently of them → no warning', () => {
    const remote = farEnd(400, 2);
    const mine = farEnd(400, 99);
    expect(run({ seconds: 20, remote, mic: (i) => ({ db: db(mine[i] ?? 0), sending: (mine[i] ?? 0) > 0.01 }) })).toBeNull();
  });

  it('turn-taking: we answer in their pauses (anti-correlated) → no warning', () => {
    const remote = farEnd(400, 3);
    expect(run({ seconds: 20, remote, mic: (_i, remoteActive) => (remoteActive ? { db: -80, sending: false } : { db: -24, sending: true }) })).toBeNull();
  });

  it('echo that never reaches the far end (PTT released) → no warning', () => {
    const remote = farEnd(400, 4);
    expect(run({ seconds: 20, remote, mic: (i) => ({ db: db(remote[i - 3] ?? 0) - 10, sending: false }) })).toBeNull();
  });

  it('is sticky for the call and clears on reset', () => {
    const remote = farEnd(400);
    const d = new EchoRiskDetector();
    const at = run({ seconds: 20, remote, mic: (i) => ({ db: db(remote[i - 2] ?? 0) - 15, sending: true }) }, d);
    expect(at).not.toBeNull();
    expect(d.risk).toBe(true);
    expect(d.reason).toBe('correlation');
    expect(d.evaluate(30_000, { erl: null, erle: null })).toBe(false); // no second «turned on»
    d.reset();
    expect(d.risk).toBe(false);
  });
});

describe('EchoRiskDetector — ERLE from media-source stats', () => {
  // A mic that sends something uncorrelated (so only the ERLE path can fire).
  const noisy = rng(7);
  const mic = (): { db: number; sending: boolean } => ({ db: -40 + noisy() * 10, sending: true });

  it('low ERLE on coupled speakers while they talk, sustained 5 s → risk', () => {
    const talking = Array.from({ length: 400 }, () => 0.05); // continuous far-end talk
    const at = run({ seconds: 20, remote: talking, mic, stats: { erl: 8, erle: 3 } });
    expect(at).not.toBeNull();
    expect(at ?? -1).toBeGreaterThanOrEqual(ECHO.sustainMs / 1000);
    expect(at ?? -1).toBeLessThanOrEqual(8);
  });

  it('low ERLE with headphones (ERL ≥ 20 dB: nothing to cancel) → no risk', () => {
    const talking = Array.from({ length: 400 }, () => 0.05);
    expect(run({ seconds: 20, remote: talking, mic, stats: { erl: 35, erle: 2 } })).toBeNull();
  });

  it('a converged filter (ERLE 15 dB) → no risk', () => {
    const talking = Array.from({ length: 400 }, () => 0.05);
    expect(run({ seconds: 20, remote: talking, mic, stats: { erl: 5, erle: 15 } })).toBeNull();
  });

  it('far end silent: ERLE says nothing → no risk', () => {
    expect(run({ seconds: 20, remote: Array.from({ length: 400 }, () => 0.001), mic, stats: { erl: 5, erle: 1 } })).toBeNull();
  });

  it('ignores the −100 «not available» sentinel', () => {
    const talking = Array.from({ length: 400 }, () => 0.05);
    expect(run({ seconds: 20, remote: talking, mic, stats: { erl: -100, erle: -100 } })).toBeNull();
  });
});

describe('RemoteActivity', () => {
  it('turns on at once and holds through a short gap', () => {
    const a = new RemoteActivity();
    expect(a.push(0.05, 0)).toBe(true);
    expect(a.push(0.001, 100)).toBe(true); // within the 150 ms hold
    expect(a.push(0.001, 200)).toBe(false);
    expect(a.push(0.019, 250)).toBe(false); // below −34 dBov
  });
});

describe('duckWanted', () => {
  const base = { mode: 'speakers' as const, echoRisk: false, remoteActive: true, micMode: 'voice' as const, pttDown: false, deafened: false };

  it('«Динамики»: ducks while someone talks, not in silence', () => {
    expect(duckWanted(base)).toBe(true);
    expect(duckWanted({ ...base, remoteActive: false })).toBe(false);
  });

  it('«Наушники» never; «Авто» only once echo was detected', () => {
    expect(duckWanted({ ...base, mode: 'headphones', echoRisk: true })).toBe(false);
    expect(duckWanted({ ...base, mode: 'auto' })).toBe(false);
    expect(duckWanted({ ...base, mode: 'auto', echoRisk: true })).toBe(true);
  });

  it('PTT held takes the floor: no duck; released PTT and VAD mode duck as usual', () => {
    expect(duckWanted({ ...base, micMode: 'ptt', pttDown: true })).toBe(false);
    expect(duckWanted({ ...base, micMode: 'ptt', pttDown: false })).toBe(true);
    expect(duckWanted({ ...base, pttDown: true })).toBe(true); // pttDown is irrelevant in VAD mode
  });

  it('deafened: nothing is played, nothing to duck', () => {
    expect(duckWanted({ ...base, deafened: true })).toBe(false);
  });

  it('the duck is −18 dB, not a mute', () => {
    expect(20 * Math.log10(DUCK_GAIN)).toBeCloseTo(-18, 5);
  });
});

describe('correlation helpers', () => {
  it('pearson of a signal with itself is 1, with its negation −1, flat → 0', () => {
    const x = [1, 3, 2, 5, 4];
    expect(pearson(x, x)).toBeCloseTo(1);
    expect(pearson(x, x.map((v) => -v))).toBeCloseTo(-1);
    expect(pearson(x, [2, 2, 2, 2, 2])).toBe(0);
  });

  it('finds a lagged copy', () => {
    const x = farEnd(100).map(db);
    const y = [-80, -80, -80, -80, ...x];
    expect(bestLagCorrelation(x, y, 8)).toBeCloseTo(1, 5);
    expect(bestLagCorrelation(x, y, 2)).toBeLessThan(0.9);
  });
});
