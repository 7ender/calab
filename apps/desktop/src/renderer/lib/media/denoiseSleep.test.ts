import { describe, expect, it } from 'vitest';
import { DENOISE_SLEEP, DenoiseScheduler, denoiseMode, rmsDb, wakeDbFor, type FrameAction } from './denoiseSleep';

const QUIET = -70;
const LOUD = -30;
const SLEEP_FRAMES = DENOISE_SLEEP.sleepMs / DENOISE_SLEEP.frameMs;

function run(s: DenoiseScheduler, db: number, frames: number): FrameAction[] {
  return Array.from({ length: frames }, () => s.step(db));
}

describe('denoiseMode', () => {
  it('is on while the mic is on air or a meter is shown', () => {
    expect(denoiseMode({ onAir: true, meter: false, micMode: 'voice', muted: false })).toBe('on');
    expect(denoiseMode({ onAir: false, meter: true, micMode: 'ptt', muted: true })).toBe('on');
  });
  it('sleeps on demand in VAD mode with the gate closed', () => {
    expect(denoiseMode({ onAir: false, meter: false, micMode: 'voice', muted: false })).toBe('auto');
  });
  it('is off with PTT released or explicitly muted', () => {
    expect(denoiseMode({ onAir: false, meter: false, micMode: 'ptt', muted: false })).toBe('off');
    expect(denoiseMode({ onAir: false, meter: false, micMode: 'voice', muted: true })).toBe('off');
  });
});

describe('DenoiseScheduler', () => {
  it('starts awake and denoises every frame in `on`', () => {
    const s = new DenoiseScheduler();
    expect(run(s, QUIET, SLEEP_FRAMES * 2).every((a) => a === 'run')).toBe(true);
    expect(s.asleep).toBe(false);
  });

  it('`auto`: sleeps after 2 s of quiet, not before', () => {
    const s = new DenoiseScheduler();
    s.control({ mode: 'auto', wakeDb: wakeDbFor(-50) });
    const acts = run(s, QUIET, SLEEP_FRAMES);
    expect(acts.slice(0, SLEEP_FRAMES - 1).every((a) => a === 'run')).toBe(true);
    expect(acts[SLEEP_FRAMES - 1]).toBe('sleep');
    expect(s.asleep).toBe(true);
  });

  it('`auto`: a frame near speech level wakes it at once (with the pre-roll), then runs', () => {
    const s = new DenoiseScheduler();
    s.control({ mode: 'auto', wakeDb: wakeDbFor(-50) });
    run(s, QUIET, SLEEP_FRAMES + 10);
    expect(s.step(LOUD)).toBe('wake');
    expect(s.step(LOUD)).toBe('run');
    // Quiet again: the 2 s tail restarts from the last loud frame.
    expect(run(s, QUIET, SLEEP_FRAMES - 1).every((a) => a === 'run')).toBe(true);
    expect(s.step(QUIET)).toBe('sleep');
  });

  it('`auto`: the wake level sits below the gate threshold, so a gate-opening frame is never slept through', () => {
    const threshold = -50;
    const s = new DenoiseScheduler();
    s.control({ mode: 'auto', wakeDb: wakeDbFor(threshold) });
    run(s, QUIET, SLEEP_FRAMES + 1);
    expect(s.step(threshold - DENOISE_SLEEP.marginDb + 1)).toBe('wake');
  });

  it('`off` never denoises; `on` wakes it on the next frame', () => {
    const s = new DenoiseScheduler();
    s.control({ mode: 'off', wakeDb: -60 });
    expect(run(s, LOUD, 50).every((a) => a === 'sleep')).toBe(true);
    s.control({ mode: 'on', wakeDb: -60 });
    expect(s.step(QUIET)).toBe('wake');
    expect(s.step(QUIET)).toBe('run');
  });

  it('entering `auto` restarts the quiet tail; repeating it does not', () => {
    const s = new DenoiseScheduler();
    s.control({ mode: 'auto', wakeDb: -60 });
    run(s, QUIET, SLEEP_FRAMES - 5);
    s.control({ mode: 'auto', wakeDb: -60 }); // same mode again: no restart
    expect(run(s, QUIET, 5).at(-1)).toBe('sleep');
    s.control({ mode: 'on', wakeDb: -60 });
    s.control({ mode: 'auto', wakeDb: -60 }); // PTT tail ended / gate closed: a fresh 2 s
    expect(run(s, QUIET, SLEEP_FRAMES - 1).every((a) => a !== 'sleep')).toBe(true);
  });
});

describe('rmsDb', () => {
  it('maps linear RMS to dBFS with a floor for silence', () => {
    expect(rmsDb(1)).toBe(0);
    expect(rmsDb(0.1)).toBeCloseTo(-20);
    expect(rmsDb(0)).toBe(-160);
  });
});
