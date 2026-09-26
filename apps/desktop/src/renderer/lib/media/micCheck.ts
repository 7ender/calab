/**
 * «Проверка микрофона» in the noise-suppression popover (docs/09 #12): 3 s of the mic as the
 * room would get it (the user's device, AEC3, RNNoise when on) → played back to me through a
 * plain `<audio>` (echo rule 1, docs/02: no WebAudio on the output). The 24-segment meter shows
 * the post-RNNoise level while recording and replays the recorded levels during playback.
 *
 * The I/O (capture, MediaRecorder, `<audio>`) is injected so the sequencing is unit-tested.
 */

export const MIC_CHECK_MS = 3000;
export const MIC_CHECK_SEGMENTS = 24;
/** Meter floor: below −60 dBFS is room noise, nothing lit (RNNoise output sits at ≈ −80 in silence). */
export const MIC_CHECK_FLOOR_DB = -60;

/** Lit segments (0…n) for a level in dBFS: linear in dB between the floor and 0 dBFS. */
export function litSegments(db: number, n = MIC_CHECK_SEGMENTS, floorDb = MIC_CHECK_FLOOR_DB): number {
  if (!Number.isFinite(db) || db <= floorDb) return 0;
  return Math.max(0, Math.min(n, Math.round(((db - floorDb) / -floorDb) * n)));
}

export interface LevelSample {
  /** ms since the recording started. */
  at: number;
  db: number;
}

/** The recorded level at `ms` into the playback (the last sample at or before it). */
export function levelAt(samples: readonly LevelSample[], ms: number): number {
  let db = -Infinity;
  for (const s of samples) {
    if (s.at > ms) break;
    db = s.db;
  }
  return db;
}

export type MicCheckPhase = 'idle' | 'recording' | 'playing';

export interface MicCheckCapture {
  /** Recording starts at once; resolves with the recording when `stop()` is called. */
  stop: () => Promise<Blob | null>;
}

export interface MicCheckDeps {
  /** Opens the mic (user's device + noise setting) and starts recording; `onDb` every ~20 ms. */
  capture: (onDb: (db: number) => void) => Promise<MicCheckCapture>;
  /** Plays the recording through `<audio>` on the output device; `onTime` with ms played; resolves at the end. */
  play: (blob: Blob, onTime: (ms: number) => void, signal: AbortSignal) => Promise<void>;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  /** Human text for a failure (lib/media/errors via services/mediaErrors). */
  describe: (err: unknown) => string;
}

export interface MicCheckState {
  phase: MicCheckPhase;
  /** The meter's level, dBFS (−Infinity = nothing). */
  db: number;
  error: string | null;
}

/**
 * One run: record 3 s, then play it back while replaying the levels. `abort` stops it at any
 * point (popover closed) and the state goes back to idle; the capture is always released.
 */
export async function runMicCheck(deps: MicCheckDeps, set: (s: MicCheckState) => void, signal: AbortSignal): Promise<void> {
  // A function, not the property: TS would keep `signal.aborted` narrowed across the awaits.
  const aborted = (): boolean => signal.aborted;
  const samples: LevelSample[] = [];
  let capture: MicCheckCapture | null = null;
  try {
    set({ phase: 'recording', db: -Infinity, error: null });
    const t0 = deps.now();
    capture = await deps.capture((db) => {
      if (aborted()) return;
      samples.push({ at: deps.now() - t0, db });
      set({ phase: 'recording', db, error: null });
    });
    if (aborted()) return;
    await deps.wait(MIC_CHECK_MS, signal);
    const c = capture;
    capture = null;
    const blob = await c.stop();
    if (aborted()) return;
    if (blob) {
      set({ phase: 'playing', db: -Infinity, error: null });
      await deps.play(blob, (ms) => set({ phase: 'playing', db: levelAt(samples, ms), error: null }), signal);
    }
    set({ phase: 'idle', db: -Infinity, error: null });
  } catch (err) {
    if (aborted()) return;
    set({ phase: 'idle', db: -Infinity, error: deps.describe(err) });
  } finally {
    if (capture) void capture.stop();
    if (aborted()) set({ phase: 'idle', db: -Infinity, error: null });
  }
}
