import { describe, expect, it } from 'vitest';
import { REMOTE_LEVEL, RemoteLevelSpeaking, readLevel, type LevelSample } from './remoteSpeaking';
import { speakingUserIds } from './speaking';

const STEP = REMOTE_LEVEL.sampleMs;

/** Feeds one level per tick for one track; returns the identities after each tick. */
function run(d: RemoteLevelSpeaking, levels: number[], start = 0, key = 't1', identity = 'u1:s1'): Array<Set<string>> {
  return levels.map((level, i) => {
    d.push([{ key, identity, level }], start + i * STEP);
    return d.identities();
  });
}

describe('RemoteLevelSpeaking hysteresis', () => {
  it('turns on after two consecutive samples at or above the on level', () => {
    const d = new RemoteLevelSpeaking();
    const out = run(d, [0.02, 0.005, 0.03, 0.02]);
    expect(out.map((s) => s.size)).toEqual([0, 0, 0, 1]);
  });

  it('a single loud sample (a click) does not light the ring', () => {
    const d = new RemoteLevelSpeaking();
    expect(run(d, [0.5, 0, 0.5, 0, 0.5, 0]).every((s) => s.size === 0)).toBe(true);
  });

  it('stays on between the off and on levels, turns off only after 250 ms below the off level', () => {
    const d = new RemoteLevelSpeaking();
    // on at t=100; 0.015 (between thresholds) keeps it; quiet from t=300: 300,400,500 → off at 550+ (t=600)
    const out = run(d, [0.05, 0.05, 0.015, 0.009, 0.009, 0.009, 0.009, 0.009]);
    expect(out.map((s) => s.size)).toEqual([0, 1, 1, 1, 1, 1, 0, 0]);
  });

  it('a short dip below the off level (< 250 ms) does not turn it off', () => {
    const d = new RemoteLevelSpeaking();
    const out = run(d, [0.05, 0.05, 0, 0, 0.012, 0, 0, 0.05]);
    expect(out.every((s, i) => i === 0 || s.size === 1)).toBe(true);
  });

  it('reports a change only when the speaking set changes', () => {
    const d = new RemoteLevelSpeaking();
    expect(d.push([{ key: 't', identity: 'a', level: 0.1 }], 0)).toBe(false);
    expect(d.push([{ key: 't', identity: 'a', level: 0.1 }], 100)).toBe(true);
    expect(d.push([{ key: 't', identity: 'a', level: 0.1 }], 200)).toBe(false);
  });

  it('forgets a track missing from a tick (unsubscribed) at once', () => {
    const d = new RemoteLevelSpeaking();
    run(d, [0.1, 0.1]);
    expect(d.identities()).toEqual(new Set(['u1:s1']));
    expect(d.push([], 300)).toBe(true);
    expect(d.identities().size).toBe(0);
    expect(d.size).toBe(0);
  });
});

describe('several devices of one user', () => {
  it('judges each track apart and lights the user once while any device speaks', () => {
    const d = new RemoteLevelSpeaking();
    const tick = (a: number, b: number, t: number): void => {
      const s: LevelSample[] = [
        { key: 'ta', identity: 'u1:laptop', level: a },
        { key: 'tb', identity: 'u1:phone', level: b },
      ];
      d.push(s, t);
    };
    tick(0.1, 0, 0);
    tick(0, 0.1, 100); // neither has two loud samples in a row
    expect(d.identities().size).toBe(0);
    tick(0, 0.1, 200);
    expect(d.identities()).toEqual(new Set(['u1:phone']));
    expect([...speakingUserIds(d.identities(), null, { userId: null, on: false })]).toEqual(['u1']);
    tick(0.1, 0.1, 300);
    tick(0.1, 0.1, 400);
    expect(d.identities()).toEqual(new Set(['u1:laptop', 'u1:phone']));
    expect([...speakingUserIds(d.identities(), null, { userId: null, on: false })]).toEqual(['u1']);
  });
});

describe('OR with the server source', () => {
  const merge = (server: string[], local: Set<string>): string[] => [...speakingUserIds([...server, ...local], 'me:s1', { userId: 'me', on: false })].sort();

  it('the local level lights someone the server missed (quiet talker)', () => {
    const d = new RemoteLevelSpeaking();
    run(d, [0.03, 0.03], 0, 't2', 'u2:s1');
    expect(merge([], d.identities())).toEqual(['u2']);
  });

  it('the server lights someone the local level does not see (no API / stale)', () => {
    expect(merge(['u3:s1'], new Set())).toEqual(['u3']);
  });

  it('both sources for one person count once; my own session from either is ignored', () => {
    const d = new RemoteLevelSpeaking();
    run(d, [0.1, 0.1], 0, 't1', 'u2:s1');
    expect(merge(['u2:s1', 'me:s1'], d.identities())).toEqual(['u2']);
  });
});

describe('readLevel', () => {
  const epoch = 1_700_000_000_000;
  const mono = 5_000;

  it('is undefined without the API (Firefox/Safari web): the server source alone', () => {
    expect(readLevel(undefined, epoch, mono)).toBeUndefined();
    expect(readLevel({}, epoch, mono)).toBeUndefined();
  });

  it('takes the loudest fresh source, on either time base; stale ones count as silence', () => {
    const rx = {
      getSynchronizationSources: () => [
        { audioLevel: 0.2, timestamp: epoch - 1_000 }, // stale
        { audioLevel: 0.05, timestamp: epoch - 20 },
        { audioLevel: 0.08, timestamp: mono - 40 }, // page-relative time base
      ],
    };
    expect(readLevel(rx, epoch, mono)).toBe(0.08);
    expect(readLevel({ getSynchronizationSources: () => [{ audioLevel: 0.9, timestamp: epoch - 5_000 }] }, epoch, mono)).toBe(0);
    expect(readLevel({ getSynchronizationSources: () => [{ timestamp: epoch }] }, epoch, mono)).toBe(0);
  });
});
