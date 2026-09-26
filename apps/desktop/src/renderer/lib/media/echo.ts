/**
 * Echo on loudspeakers (docs/02-media.md, «Эхо: колонки»): the residual-echo detector behind the
 * «собеседник слышит себя» warning and the speakerphone ducking logic. Pure: the voice service
 * feeds it levels and stats, tests feed it synthetic ones.
 */

/** «Как вы слушаете»: headphones (no ducking), speakers (duck while others talk), auto (duck once echo is detected). */
export type EchoMode = 'headphones' | 'speakers' | 'auto';

export const ECHO = {
  /** Level sampling period of the voice service (remote SSRC levels + the mic worklet level). */
  frameMs: 50,
  /** getStats period (voice STATS_INTERVAL_MS). */
  statsMs: 2000,
  /**
   * Remote talks: RFC 6464 level (0..1, linear, `getSynchronizationSources().audioLevel`) times
   * the element volume ≥ 0.02 ≈ −34 dBov. Speech sits at −20…−30 dBov, DTX / comfort noise
   * well below −50; LiveKit's own speaker detection uses a similar ~−35 dBov cut.
   */
  remoteOnLevel: 0.02,
  /** Bridges syllable gaps so the duck does not pump; the gain release (300 ms) comes on top. */
  remoteHoldMs: 150,
  /**
   * ERLE of AEC3's linear filter below 6 dB while the far end talks = the filter has not
   * converged (reference/delay mismatch, clock drift, distorting speakers): a converged filter
   * on laptop speakers gives 10–25 dB. One unconverged moment is normal (start-up, a device
   * switch), so it has to hold for 5 s.
   */
  erleLowDb: 6,
  /**
   * …and only when there is echo worth cancelling: ERL (render → mic loss) below 20 dB means
   * the speaker is acoustically coupled to the mic. Headphones give ERL ≥ 30 dB, where a low
   * ERLE only says «nothing to cancel».
   */
  erlCoupledDb: 20,
  sustainMs: 5000,
  /** The far end must talk for at least half of a stats period to judge it. */
  remoteShareMin: 0.5,
  /** …and our mic must actually be on air for part of it (PTT released / gate closed = nothing leaks). */
  sendShareMin: 0.3,
  /** Correlation path: 5 s window of frames. */
  windowMs: 5000,
  /** Echo follows the far-end envelope with the playout + acoustic + capture delay: 0–400 ms. */
  maxLagMs: 400,
  corrMin: 0.6,
  /** Share of far-end talk frames in which we sent something above the floor. */
  leakShareMin: 0.4,
  /** Two consecutive bad windows (≈ 7 s of echo) before warning — a false alarm costs a toast. */
  corrBadEvals: 2,
  /** Anything quieter than this (post-AEC mic, dBFS) is not heard as echo. */
  micFloorDb: -60,
  floorDb: -80,
  /** Ducking: −18 dB (not a mute: the far end still hears us trying to interrupt), 20 ms attack, 300 ms release. */
  duckDb: -18,
  attackMs: 20,
  releaseMs: 300,
} as const;

export const DUCK_GAIN = 10 ** (ECHO.duckDb / 20);

export function levelToDb(level: number): number {
  return level > 0 ? Math.max(ECHO.floorDb, 20 * Math.log10(level)) : ECHO.floorDb;
}

/** Far-end talk with a short hold (ECHO.remoteHoldMs), from the per-frame remote level. */
export class RemoteActivity {
  private lastOn = -Infinity;
  active = false;

  push(level: number, t: number): boolean {
    if (level >= ECHO.remoteOnLevel) {
      this.lastOn = t;
      this.active = true;
    } else if (t - this.lastOn > ECHO.remoteHoldMs) {
      this.active = false;
    }
    return this.active;
  }

  reset(): void {
    this.lastOn = -Infinity;
    this.active = false;
  }
}

export interface EchoFrame {
  t: number;
  /** Loudest remote voice as played (RFC 6464 level × element volume), 0..1. */
  remote: number;
  remoteActive: boolean;
  /** Post-AEC mic level (dBFS) as sent: the duck offset applied; ignored when not sending. */
  micDb: number;
  /** Our mic is on air (gate open / PTT held, not muted). */
  sending: boolean;
}

/** AEC metrics of the published mic (`media-source` stats); null = not reported. */
export interface EchoStats {
  erl: number | null;
  erle: number | null;
}

export type EchoReason = 'erle' | 'correlation';

/**
 * Residual echo reaching the far end. Two independent signals:
 *  - ERLE (when Chromium reports it — only while the published track is the getUserMedia
 *    track itself, i.e. RNNoise off): low ERLE with a coupled speaker while they talk, 5 s;
 *  - correlation (always): what we send follows the far-end envelope with a 0–400 ms lag
 *    while they talk. Double talk is uncorrelated, turn-taking is anti-correlated, echo is
 *    strongly positive. This is what the far end actually hears (post-AEC, post-RNNoise, gated).
 * Sticky for the call: ducking lowers the very echo it measures, so clearing on a good window
 * would flap the duck on and off. Reset on a new call or a device change.
 */
export class EchoRiskDetector {
  private frames: EchoFrame[] = [];
  private erleBadSince: number | null = null;
  private corrBad = 0;
  risk = false;
  reason: EchoReason | null = null;
  /** Best correlation of the last full window (dev stats). */
  lastCorr: number | null = null;

  pushFrame(f: EchoFrame): void {
    this.frames.push(f);
    const from = f.t - ECHO.windowMs;
    let drop = 0;
    while (drop < this.frames.length && (this.frames[drop]?.t ?? 0) < from) drop++;
    if (drop > 0) this.frames.splice(0, drop);
  }

  /** Called every stats period; returns true when the risk turned on just now. */
  evaluate(t: number, stats: EchoStats): boolean {
    if (this.risk) return false;
    const recent = this.frames.filter((f) => f.t > t - ECHO.statsMs);
    const talk = recent.filter((f) => f.remoteActive);
    const remoteShare = recent.length ? talk.length / recent.length : 0;
    const sendShare = talk.length ? talk.filter((f) => f.sending).length / talk.length : 0;
    const judged = remoteShare >= ECHO.remoteShareMin && sendShare >= ECHO.sendShareMin;

    const erleLow = valid(stats.erle) && stats.erle < ECHO.erleLowDb && (!valid(stats.erl) || stats.erl < ECHO.erlCoupledDb);
    if (judged && erleLow) {
      this.erleBadSince ??= t - ECHO.statsMs; // the sample covers the period before it
      if (t - this.erleBadSince >= ECHO.sustainMs) return this.raise('erle');
    } else {
      this.erleBadSince = null;
    }

    this.corrBad = this.correlationBad(t) ? this.corrBad + 1 : 0;
    if (this.corrBad >= ECHO.corrBadEvals) return this.raise('correlation');
    return false;
  }

  reset(): void {
    this.frames = [];
    this.erleBadSince = null;
    this.corrBad = 0;
    this.risk = false;
    this.reason = null;
    this.lastCorr = null;
  }

  private raise(reason: EchoReason): boolean {
    this.risk = true;
    this.reason = reason;
    return true;
  }

  private correlationBad(t: number): boolean {
    const w = this.frames.filter((f) => f.t > t - ECHO.windowMs);
    const expected = ECHO.windowMs / ECHO.frameMs;
    if (w.length < expected * 0.8) return false; // not a full window yet
    const talk = w.filter((f) => f.remoteActive);
    // Needs far-end talk *and* pauses: the envelope has to move to correlate with anything.
    if (talk.length < 30 || w.length - talk.length < 10) return false;
    const leaked = talk.filter((f) => f.sending && f.micDb > ECHO.micFloorDb).length / talk.length;
    const remote = w.map((f) => levelToDb(f.remote));
    const mic = w.map((f) => (f.sending ? Math.max(ECHO.floorDb, f.micDb) : ECHO.floorDb));
    const corr = bestLagCorrelation(remote, mic, Math.round(ECHO.maxLagMs / ECHO.frameMs));
    this.lastCorr = corr;
    return leaked >= ECHO.leakShareMin && corr >= ECHO.corrMin;
  }
}

/** Chromium reports missing AEC metrics as absent or −100 (legacy sentinel). */
function valid(v: number | null): v is number {
  return v !== null && Number.isFinite(v) && v > -100;
}

/** Pearson correlation of x[i] and y[i + lag], the best over lag 0..maxLag (y lags x). */
export function bestLagCorrelation(x: readonly number[], y: readonly number[], maxLag: number): number {
  let best = -1;
  for (let lag = 0; lag <= maxLag; lag++) {
    const n = Math.min(x.length, y.length - lag);
    if (n < 8) break;
    const c = pearson(x.slice(0, n), y.slice(lag, lag + n));
    if (c > best) best = c;
  }
  return best;
}

export function pearson(x: readonly number[], y: readonly number[]): number {
  const n = Math.min(x.length, y.length);
  if (n === 0) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i] ?? 0;
    my += y[i] ?? 0;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] ?? 0) - mx;
    const dy = (y[i] ?? 0) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  // A flat signal (mic never on air, remote never silent) correlates with nothing.
  if (sxx < 1e-9 || syy < 1e-9) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

export interface DuckInput {
  mode: EchoMode;
  echoRisk: boolean;
  remoteActive: boolean;
  micMode: 'voice' | 'ptt';
  pttDown: boolean;
  deafened: boolean;
}

/**
 * Speakerphone ducking (Zoom-style half duplex, but gentle): our mic −18 dB while someone else
 * talks. «Динамики» always, «Авто» once echo was detected, «Наушники» never. Not while PTT is
 * held (the user explicitly takes the floor) and not while deafened (nothing is played).
 */
export function duckWanted(s: DuckInput): boolean {
  if (s.deafened || !s.remoteActive) return false;
  if (s.micMode === 'ptt' && s.pttDown) return false;
  return s.mode === 'speakers' || (s.mode === 'auto' && s.echoRisk);
}

/** The capture needs a gain stage (a WebAudio graph before the publish track) in this mode. */
export function duckable(mode: EchoMode): boolean {
  return mode !== 'headphones';
}
