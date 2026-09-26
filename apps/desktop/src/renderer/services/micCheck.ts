import { create } from 'zustand';
import { MicPipeline } from '../lib/media/micPipeline';
import { runMicCheck, type MicCheckCapture, type MicCheckDeps, type MicCheckState } from '../lib/media/micCheck';
import { rmsToDb } from '../lib/media/vad';
import { usePrefs } from '../stores/prefs';
import { humanMediaError } from './mediaErrors';

/**
 * The noise-suppression popover's mic check (docs/09 #12, lib/media/micCheck.ts). A separate
 * capture from the call's (MicPipeline with the user's device and RNNoise setting), so mute,
 * PTT and the voice gate don't silence the recording; played back to me only — a plain
 * `<audio>` with `setSinkId` on my output device (echo rules 1–2, docs/02).
 */
export const useMicCheck = create<MicCheckState>()(() => ({ phase: 'idle', db: -Infinity, error: null }));

let running: AbortController | null = null;

async function capture(onDb: (db: number) => void): Promise<MicCheckCapture> {
  const p = usePrefs.getState();
  const mic = await MicPipeline.start({ deviceId: p.micDeviceId, rnnoise: p.rnnoise, onReport: (r) => onDb(rmsToDb(r.rms)) });
  const chunks: Blob[] = [];
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(new MediaStream([mic.track]));
  } catch (err) {
    mic.stop();
    throw err;
  }
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  rec.start();
  let stopped: Promise<Blob | null> | null = null;
  return {
    stop: () =>
      (stopped ??= new Promise<Blob | null>((resolve) => {
        const done = (): void => {
          mic.stop();
          resolve(chunks.length ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null);
        };
        if (rec.state === 'inactive') {
          done();
          return;
        }
        rec.onstop = done;
        rec.stop();
      })),
  };
}

async function play(blob: Blob, onTime: (ms: number) => void, signal: AbortSignal): Promise<void> {
  const url = URL.createObjectURL(blob);
  const el = new Audio(url);
  let frame = 0;
  try {
    const sink = usePrefs.getState().outputDeviceId;
    if (sink) await el.setSinkId(sink).catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => resolve();
      el.onended = finish;
      el.onerror = () => reject(new Error('playback failed'));
      signal.addEventListener('abort', finish, { once: true });
      // rAF, not `timeupdate` (≈ 4 Hz): the meter follows the playback at the display rate.
      const tick = (): void => {
        onTime(el.currentTime * 1000);
        frame = requestAnimationFrame(tick);
      };
      el.play().then(() => (frame = requestAnimationFrame(tick)), reject);
    });
  } finally {
    cancelAnimationFrame(frame);
    el.pause();
    el.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

const deps: MicCheckDeps = {
  capture,
  play,
  wait,
  now: () => performance.now(),
  describe: (err) => humanMediaError(err, 'mic').text,
};

/** Starts the check (a second click while it runs stops it). */
export function toggleMicCheck(): void {
  if (running) {
    stopMicCheck();
    return;
  }
  const ctl = new AbortController();
  running = ctl;
  void runMicCheck(deps, (s) => useMicCheck.setState(s), ctl.signal).finally(() => {
    if (running === ctl) running = null;
  });
}

/** Popover closed / panel gone: release the mic and stop the playback. */
export function stopMicCheck(): void {
  running?.abort();
  running = null;
  useMicCheck.setState({ phase: 'idle', db: -Infinity });
}
