/**
 * Local measurement of who speaks among the remote participants (docs/02 «Индикация речи
 * собеседников»). The server's ActiveSpeakersChanged is a smoothed, windowed verdict that arrives
 * every `audio.update_interval` and drops quiet talkers; this one reads the RFC 6464 level the
 * sender put on every audio packet (`RTCRtpReceiver.getSynchronizationSources()`, linear 0..1) —
 * no WebAudio on the remote path (echo rule 1). The two sources are OR-ed by the caller.
 *
 * Per track: on after `ON_SAMPLES` consecutive samples ≥ `ON_LEVEL`; off after the level stays
 * below `OFF_LEVEL` for `OFF_MS` (hysteresis — in between keeps the current state). Pure logic,
 * no LiveKit, no timers: the caller samples every `SAMPLE_MS`.
 */
export const REMOTE_LEVEL = {
  sampleMs: 100,
  /** ≈ −34 dBov. */
  onLevel: 0.02,
  onSamples: 2,
  /** ≈ −40 dBov. */
  offLevel: 0.01,
  offMs: 250,
  /** A level older than this is no speech (the sender went quiet/muted, DTX stopped packets). */
  freshMs: 250,
} as const;

/** The part of RTCRtpReceiver we use; optional, since Firefox/Safari web may lack it. */
export interface LevelReceiver {
  getSynchronizationSources?: () => ReadonlyArray<{ audioLevel?: number; timestamp: number }>;
}

/**
 * The current level of one receiver: `undefined` — the API is missing (no local source, rely on
 * the server), else the loudest fresh level (0 when nothing fresh). `epoch`/`mono`: the spec time
 * base is performance.timeOrigin + performance.now(); some builds report page-relative time.
 */
export function readLevel(rx: LevelReceiver | undefined, epoch: number, mono: number, freshMs: number = REMOTE_LEVEL.freshMs): number | undefined {
  if (!rx || typeof rx.getSynchronizationSources !== 'function') return undefined;
  let level = 0;
  for (const src of rx.getSynchronizationSources()) {
    if (Math.min(Math.abs(epoch - src.timestamp), Math.abs(mono - src.timestamp)) > freshMs) continue;
    level = Math.max(level, src.audioLevel ?? 0);
  }
  return level;
}

export interface LevelSample {
  /** Track key (sid): one person on two devices is two tracks, judged apart. */
  key: string;
  /** LiveKit identity of the track's owner. */
  identity: string;
  level: number;
}

interface TrackState {
  identity: string;
  on: boolean;
  loud: number;
  quietSince: number | null;
}

export class RemoteLevelSpeaking {
  private readonly tracks = new Map<string, TrackState>();
  private key = '';

  constructor(private readonly cfg: typeof REMOTE_LEVEL = REMOTE_LEVEL) {}

  /**
   * One sampling tick: every track that has a local level now. Tracks missing from `samples` are
   * forgotten (unsubscribed, or no API). Returns true when the set of speaking identities changed.
   */
  push(samples: Iterable<LevelSample>, now: number): boolean {
    const seen = new Set<string>();
    for (const s of samples) {
      seen.add(s.key);
      let st = this.tracks.get(s.key);
      if (!st) {
        st = { identity: s.identity, on: false, loud: 0, quietSince: null };
        this.tracks.set(s.key, st);
      }
      st.identity = s.identity;
      this.step(st, s.level, now);
    }
    for (const k of [...this.tracks.keys()]) if (!seen.has(k)) this.tracks.delete(k);
    return this.refresh();
  }

  /** Identities speaking by the local measurement. */
  identities(): Set<string> {
    const out = new Set<string>();
    for (const st of this.tracks.values()) if (st.on) out.add(st.identity);
    return out;
  }

  /** How many tracks are tracked (0 → the caller has nothing to sample). */
  get size(): number {
    return this.tracks.size;
  }

  reset(): void {
    this.tracks.clear();
    this.key = '';
  }

  private step(st: TrackState, level: number, now: number): void {
    const c = this.cfg;
    st.loud = level >= c.onLevel ? st.loud + 1 : 0;
    if (!st.on) {
      if (st.loud >= c.onSamples) {
        st.on = true;
        st.quietSince = null;
      }
      return;
    }
    if (level >= c.offLevel) {
      st.quietSince = null;
      return;
    }
    st.quietSince ??= now;
    if (now - st.quietSince >= c.offMs) {
      st.on = false;
      st.quietSince = null;
    }
  }

  private refresh(): boolean {
    const key = [...this.identities()].sort().join('\n');
    if (key === this.key) return false;
    this.key = key;
    return true;
  }
}
