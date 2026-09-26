import { describe, expect, it } from 'vitest';
import { MIC_CHECK_MS, MIC_CHECK_SEGMENTS, levelAt, litSegments, runMicCheck, type MicCheckDeps, type MicCheckState } from './micCheck';

describe('litSegments', () => {
  it('lights nothing at or below the floor and in silence', () => {
    expect(litSegments(-Infinity)).toBe(0);
    expect(litSegments(-80)).toBe(0);
    expect(litSegments(-60)).toBe(0);
    expect(litSegments(Number.NaN)).toBe(0);
  });

  it('is linear in dB up to all 24 at 0 dBFS', () => {
    expect(MIC_CHECK_SEGMENTS).toBe(24);
    expect(litSegments(-30)).toBe(12);
    expect(litSegments(-15)).toBe(18);
    expect(litSegments(0)).toBe(24);
    expect(litSegments(6)).toBe(24);
  });
});

describe('levelAt', () => {
  const s = [
    { at: 0, db: -50 },
    { at: 20, db: -20 },
    { at: 40, db: -40 },
  ];
  it('returns the last sample at or before the time', () => {
    expect(levelAt(s, 0)).toBe(-50);
    expect(levelAt(s, 25)).toBe(-20);
    expect(levelAt(s, 1000)).toBe(-40);
    expect(levelAt([], 10)).toBe(-Infinity);
  });
});

/** Fake I/O: a clock, a capture that reports given levels, a playback that replays given times. */
function fakes(opts: { levels?: number[]; playTimes?: number[]; captureError?: Error; blob?: Blob | null } = {}): {
  deps: MicCheckDeps;
  states: MicCheckState[];
  stopped: () => number;
  waited: () => number[];
  played: () => number;
} {
  let clock = 0;
  let stops = 0;
  let plays = 0;
  const waits: number[] = [];
  const states: MicCheckState[] = [];
  const deps: MicCheckDeps = {
    now: () => clock,
    capture: (onDb) => {
      if (opts.captureError) return Promise.reject(opts.captureError);
      for (const db of opts.levels ?? []) {
        clock += 20;
        onDb(db);
      }
      return Promise.resolve({
        stop: () => {
          stops++;
          return Promise.resolve(opts.blob === undefined ? new Blob(['x']) : opts.blob);
        },
      });
    },
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    play: (_blob, onTime) => {
      plays++;
      for (const t of opts.playTimes ?? []) onTime(t);
      return Promise.resolve();
    },
    describe: (err) => `human: ${(err as Error).message}`,
  };
  return { deps, states, stopped: () => stops, waited: () => waits, played: () => plays };
}

describe('runMicCheck', () => {
  it('records 3 s with the live level, then plays back replaying the recorded levels', async () => {
    const f = fakes({ levels: [-50, -20], playTimes: [20, 45] });
    await runMicCheck(f.deps, (s) => f.states.push(s), new AbortController().signal);
    expect(f.waited()).toEqual([MIC_CHECK_MS]);
    expect(f.stopped()).toBe(1);
    expect(f.played()).toBe(1);
    const trail = f.states.map((s) => `${s.phase}:${s.db}`);
    expect(trail).toEqual(['recording:-Infinity', 'recording:-50', 'recording:-20', 'playing:-Infinity', 'playing:-50', 'playing:-20', 'idle:-Infinity']);
  });

  it('skips playback when nothing was recorded', async () => {
    const f = fakes({ blob: null });
    await runMicCheck(f.deps, (s) => f.states.push(s), new AbortController().signal);
    expect(f.played()).toBe(0);
    expect(f.states.at(-1)?.phase).toBe('idle');
  });

  it('reports a capture failure in human words and ends idle', async () => {
    const f = fakes({ captureError: new Error('NotAllowedError') });
    await runMicCheck(f.deps, (s) => f.states.push(s), new AbortController().signal);
    expect(f.states.at(-1)).toEqual({ phase: 'idle', db: -Infinity, error: 'human: NotAllowedError' });
  });

  it('abort (popover closed) releases the capture, never plays, ends idle without an error', async () => {
    const f = fakes({ levels: [-30] });
    const ctl = new AbortController();
    f.deps.wait = () => {
      ctl.abort();
      return Promise.resolve();
    };
    await runMicCheck(f.deps, (s) => f.states.push(s), ctl.signal);
    expect(f.stopped()).toBe(1);
    expect(f.played()).toBe(0);
    expect(f.states.at(-1)).toEqual({ phase: 'idle', db: -Infinity, error: null });
  });
});
