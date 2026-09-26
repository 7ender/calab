import { bestLagCorrelation } from './echo';

/**
 * «Проверка эха» (Settings → «Голос и устройства»): a short, quiet test signal is played the
 * way remote voices are (a WebRTC track into a plain <audio>, services/echoCheck.ts) while the
 * mic is recorded post-AEC; this module builds the signal and judges how much of it came back.
 * Pure: tests run it on synthetic levels.
 */

export const CHECK = {
  sampleRate: 48000,
  /** Mic worklet report period. */
  frameMs: 20,
  /** Continuous signal first: AEC3 needs ~1 s to converge, as it is in a running call. */
  warmupMs: 1000,
  /** Then bursts in a fixed irregular pattern (ms, on/off alternating) — 2 s. */
  pattern: [200, 200, 100, 300, 300, 100, 200, 200, 100, 300] as readonly number[],
  /** Recording continues past the signal for the playout + acoustic delay. */
  tailMs: 400,
  /** RMS of the signal, dBFS: a remote voice at a normal level, not a loud beep. */
  levelDb: -28,
  maxLagMs: 400,
} as const;

export const CHECK_TOTAL_MS = CHECK.warmupMs + CHECK.pattern.reduce((a, b) => a + b, 0) + CHECK.tailMs;

export type EchoLevel = 'none' | 'weak' | 'strong';

export interface EchoCheckResult {
  level: EchoLevel;
  /** Mic level during bursts minus during gaps (dB) at the best lag. */
  deltaDb: number;
  /** Mean mic level during bursts, dBFS. */
  returnDb: number;
  corr: number;
  lagMs: number;
}

/** On/off per analysis frame over the pattern part (after the warm-up). */
export function patternFrames(frameMs: number = CHECK.frameMs): boolean[] {
  const out: boolean[] = [];
  let on = true;
  for (const ms of CHECK.pattern) {
    for (let i = 0; i < Math.round(ms / frameMs); i++) out.push(on);
    on = !on;
  }
  return out;
}

/**
 * The test signal: a synthetic vowel — harmonics of a gliding 110–190 Hz pitch up to ≈ 3.4 kHz,
 * 1/k amplitudes. Voice-like on purpose: RNNoise and Chromium's noise suppressor keep it (a
 * noise burst would be removed as noise and hide the echo), and AEC3 is tuned for speech.
 * 5 ms fades on every burst edge.
 */
export function testSignal(sampleRate: number = CHECK.sampleRate): Float32Array<ArrayBuffer> {
  const ms = CHECK.warmupMs + CHECK.pattern.reduce((a, b) => a + b, 0);
  const n = Math.round((ms / 1000) * sampleRate);
  const out = new Float32Array(n);
  const HARMONICS = 30;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f0 = 150 + 40 * Math.sin(2 * Math.PI * 0.7 * t);
    phase += (2 * Math.PI * f0) / sampleRate;
    let v = 0;
    for (let k = 1; k <= HARMONICS; k++) {
      const taper = Math.min(1, Math.max(0, (3600 - k * f0) / 400)); // soft band edge, no clicks as f0 moves
      if (taper > 0) v += (taper / k) * Math.sin(k * phase);
    }
    out[i] = v;
  }
  // Envelope: warm-up on, then the pattern.
  const fade = Math.round(0.005 * sampleRate);
  const edges: { from: number; to: number }[] = [{ from: 0, to: Math.round((CHECK.warmupMs / 1000) * sampleRate) }];
  let at = CHECK.warmupMs;
  CHECK.pattern.forEach((len, k) => {
    if (k % 2 === 0) edges.push({ from: Math.round((at / 1000) * sampleRate), to: Math.round(((at + len) / 1000) * sampleRate) });
    at += len;
  });
  const env = new Float32Array(n);
  for (const { from, to } of edges) {
    for (let i = from; i < to && i < n; i++) env[i] = Math.min(1, (i - from) / fade, (to - 1 - i) / fade);
  }
  // Level = RMS while sounding (the gaps are silence by design).
  let sq = 0;
  let on = 0;
  for (let i = 0; i < n; i++) {
    const e = Math.max(0, env[i] ?? 0);
    out[i] = (out[i] ?? 0) * e;
    if (e > 0) {
      sq += (out[i] ?? 0) ** 2;
      on++;
    }
  }
  const gain = 10 ** (CHECK.levelDb / 20) / Math.sqrt(sq / (on || 1) || 1);
  for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) * gain;
  return out;
}

/**
 * Judges the recording. `micDb[k]` is the post-AEC mic level of frame k (CHECK.frameMs), frame 0
 * = the moment the signal started. `gateDb` is the user's voice-activation threshold: a return
 * above it would open the gate and be sent.
 *  - none: the bursts are not in the recording (no correlation, < 3 dB above the gaps, or below −65 dBFS);
 *  - strong: ≥ 10 dB above the gaps and loud enough to open the gate — the far end hears itself;
 *  - weak: in between — audible to the far end at times, usually covered by AEC's suppressor.
 */
export function analyseEchoCheck(micDb: readonly number[], gateDb: number, frameMs: number = CHECK.frameMs): EchoCheckResult {
  const pattern = patternFrames(frameMs);
  const start = Math.round(CHECK.warmupMs / frameMs);
  const maxLag = Math.round(CHECK.maxLagMs / frameMs);
  const ref = pattern.map((on) => (on ? 1 : 0));
  let best = { corr: -1, lag: 0 };
  for (let lag = 0; lag <= maxLag; lag++) {
    const seg = micDb.slice(start + lag, start + lag + ref.length);
    if (seg.length < ref.length) break;
    const c = bestLagCorrelation(ref, seg, 0);
    if (c > best.corr) best = { corr: c, lag };
  }
  const seg = micDb.slice(start + best.lag, start + best.lag + ref.length);
  const on = seg.filter((_, i) => pattern[i]);
  const off = seg.filter((_, i) => !pattern[i]);
  const mean = (a: readonly number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : -80);
  const returnDb = mean(on);
  const deltaDb = returnDb - mean(off);
  const corr = Math.max(0, best.corr);
  let level: EchoLevel = 'weak';
  if (corr < 0.3 || deltaDb < 3 || returnDb < -65) level = 'none';
  else if (deltaDb >= 10 && returnDb >= gateDb) level = 'strong';
  return { level, deltaDb, returnDb, corr, lagMs: best.lag * frameMs };
}
