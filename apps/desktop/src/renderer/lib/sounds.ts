import { prefs } from '../stores/prefs';
// New-message cue (docs/09 P1 #13): pre-rendered by scripts/gen-sounds.mjs, bundled as an asset.
import messageWavUrl from '../../../resources/sounds/message.wav?url';

/**
 * UI event sounds (docs/09 #29). Short (≤ 300 ms) tones synthesised once into WAV blobs (the new
 * message cue is a bundled WAV, FILE_SOUNDS) and
 * played through a plain <audio> element on the selected output device — never through
 * WebAudio, so AEC3 sees them as WebRTC-independent playback exactly like any other system
 * sound (docs/02, echo rule 1).
 */
export const SOUND_EVENTS = [
  'join',
  'leave',
  'mute',
  'unmute',
  'deafen',
  'undeafen',
  'pttOn',
  'pttOff',
  'mention',
  'message',
  'streamStart',
  'moved',
  'disconnect',
  'reconnect',
] as const;

export type SoundName = (typeof SOUND_EVENTS)[number];

/**
 * Events played from a bundled file rather than a synthesised tone (still a plain <audio>).
 * Their SOUNDS entry is only the fallback when the file cannot be loaded.
 */
export const FILE_SOUNDS: Partial<Record<SoundName, string>> = { message: messageWavUrl };

/** One partial of a sound: frequency (Hz), start and length (s), relative gain. */
export interface Note {
  f: number;
  at: number;
  dur: number;
  gain?: number;
}

/*
 * Timbre: a soft "glass" tone — fundamental + weak 2nd/3rd harmonics, 4 ms attack and an
 * exponential decay, so notes ring out naturally instead of stopping like a beep.
 * Pairs rise for "on/in" and fall for "off/out" (macOS/Discord convention).
 */
export const SOUNDS: Record<SoundName, Note[]> = {
  join: [
    { f: 659.25, at: 0, dur: 0.12 },
    { f: 987.77, at: 0.07, dur: 0.18 },
  ],
  leave: [
    { f: 987.77, at: 0, dur: 0.12 },
    { f: 659.25, at: 0.07, dur: 0.18 },
  ],
  mute: [{ f: 587.33, at: 0, dur: 0.1, gain: 0.8 }],
  unmute: [{ f: 783.99, at: 0, dur: 0.1, gain: 0.8 }],
  deafen: [
    { f: 587.33, at: 0, dur: 0.1, gain: 0.8 },
    { f: 440, at: 0.06, dur: 0.14, gain: 0.8 },
  ],
  undeafen: [
    { f: 440, at: 0, dur: 0.1, gain: 0.8 },
    { f: 587.33, at: 0.06, dur: 0.14, gain: 0.8 },
  ],
  pttOn: [{ f: 1174.66, at: 0, dur: 0.05, gain: 0.45 }],
  pttOff: [{ f: 880, at: 0, dur: 0.05, gain: 0.4 }],
  mention: [
    { f: 1046.5, at: 0, dur: 0.09 },
    { f: 1318.51, at: 0.06, dur: 0.09 },
    { f: 1567.98, at: 0.12, dur: 0.16 },
  ],
  message: [
    { f: 987.77, at: 0, dur: 0.08, gain: 0.7 },
    { f: 1318.51, at: 0.06, dur: 0.14, gain: 0.7 },
  ],
  streamStart: [
    { f: 523.25, at: 0, dur: 0.1 },
    { f: 659.25, at: 0.07, dur: 0.1 },
    { f: 783.99, at: 0.14, dur: 0.16 },
  ],
  moved: [
    { f: 698.46, at: 0, dur: 0.1 },
    { f: 698.46, at: 0.1, dur: 0.16, gain: 0.6 },
    { f: 880, at: 0.1, dur: 0.16 },
  ],
  disconnect: [
    { f: 392, at: 0, dur: 0.12 },
    { f: 293.66, at: 0.09, dur: 0.2 },
  ],
  reconnect: [
    { f: 293.66, at: 0, dur: 0.1 },
    { f: 392, at: 0.07, dur: 0.1 },
    { f: 587.33, at: 0.14, dur: 0.16 },
  ],
};

export const SAMPLE_RATE = 24000;
const PEAK = 0.32 * 32767;

/** PCM samples of a sound (mono, SAMPLE_RATE). Pure: used by tests. */
export function synth(notes: readonly Note[], sr = SAMPLE_RATE): Int16Array {
  const end = notes.reduce((a, n) => Math.max(a, n.at + n.dur), 0);
  const total = Math.ceil(end * sr);
  const buf = new Float32Array(total);
  for (const n of notes) {
    const start = Math.round(n.at * sr);
    const len = Math.round(n.dur * sr);
    const attack = Math.round(0.004 * sr);
    const release = Math.round(0.012 * sr);
    const tau = n.dur / 3.2;
    const g = n.gain ?? 1;
    for (let i = 0; i < len && start + i < total; i++) {
      const tt = i / sr;
      const w = 2 * Math.PI * n.f * tt;
      const tone = Math.sin(w) + 0.22 * Math.sin(2 * w) + 0.06 * Math.sin(3 * w);
      // Attack ramp, exponential ring-out, and a short linear fade at the end (no click).
      const env = Math.min(1, i / attack) * Math.exp(-tt / tau) * Math.min(1, (len - i) / release);
      buf[start + i] = (buf[start + i] ?? 0) + tone * env * g;
    }
  }
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const norm = peak > 1 ? 1 / peak : 1;
  const out = new Int16Array(total);
  for (let i = 0; i < total; i++) out[i] = Math.round((buf[i] ?? 0) * norm * PEAK);
  return out;
}

/** Duration of a sound in ms. */
export function durationMs(name: SoundName): number {
  return Math.round(SOUNDS[name].reduce((a, n) => Math.max(a, n.at + n.dur), 0) * 1000);
}

/** 16-bit mono PCM → WAV blob (UI sounds; the echo check fallback player). */
export function wav(pcm: Int16Array, sr = SAMPLE_RATE): Blob {
  const dv = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length * 2, true);
  w(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i] ?? 0, true);
  return new Blob([dv.buffer], { type: 'audio/wav' });
}

/** Whether an event sound is enabled in the preferences (master switch + per-event toggle). */
export function soundEnabled(name: SoundName): boolean {
  const p = prefs();
  return p.voiceSounds && p.sounds[name] !== false;
}

/** The same sound fired in a burst (e.g. several people moved in at once) plays once. */
const MIN_GAP_MS = 150;
/** Chat sounds in a busy room: at most one per interval (docs/09 P1 #13: a message ≤ 1 per 2 s). */
export const GAP_MS: Partial<Record<SoundName, number>> = { message: 2000, mention: 1000 };

export interface SoundGate {
  /** Whether `name` may play at `now` (ms); a «yes» is recorded as a play. */
  allow: (name: SoundName, now: number) => boolean;
  /** Records a play that bypassed the gate (the «прослушать» button). */
  mark: (name: SoundName, now: number) => void;
}

/** Per-event rate limit. Pure (clock passed in): used by tests. */
export function createGate(gaps: Partial<Record<SoundName, number>> = GAP_MS, minGap = MIN_GAP_MS): SoundGate {
  const last = new Map<SoundName, number>();
  return {
    allow: (name, now) => {
      if (now - (last.get(name) ?? -Infinity) < (gaps[name] ?? minGap)) return false;
      last.set(name, now);
      return true;
    },
    mark: (name, now) => void last.set(name, now),
  };
}

const cache = new Map<SoundName, string>();
const gate = createGate();
/** After «moved», the new room's participants arrive as joins/leaves: not worth a sound each. */
const SUPPRESS: Partial<Record<SoundName, { names: SoundName[]; ms: number }>> = {
  moved: { names: ['join', 'leave'], ms: 1500 },
};
const suppressedUntil = new Map<SoundName, number>();

function synthUrl(name: SoundName): string {
  let url = cache.get(name);
  if (!url) {
    url = URL.createObjectURL(wav(synth(SOUNDS[name])));
    cache.set(name, url);
  }
  return url;
}

export interface PlayOptions {
  /** Play regardless of the toggles and the rate limit (the «прослушать» button in settings). */
  force?: boolean;
  /** Multiplier on the user's sound volume (the quieter cue in the open chat). */
  volume?: number;
}

/** Plays an event sound if enabled, through a plain <audio> element on the output device. */
export function playSound(name: SoundName, opts: PlayOptions = {}): void {
  const now = performance.now();
  if (!opts.force) {
    const sup = SUPPRESS[name];
    if (sup) for (const n of sup.names) suppressedUntil.set(n, now + sup.ms);
    if (!soundEnabled(name)) return;
    if (now < (suppressedUntil.get(name) ?? 0)) return;
    if (!gate.allow(name, now)) return;
  } else gate.mark(name, now);
  const p = prefs();
  const file = FILE_SOUNDS[name];
  const el = new Audio(file ?? synthUrl(name));
  el.volume = Math.max(0, Math.min(1, p.soundVolume * (opts.volume ?? 1)));
  // A bundled file that cannot be loaded falls back to its synthesised stand-in (once).
  if (file) el.onerror = () => {
    el.onerror = null;
    el.src = synthUrl(name);
    play();
  };
  const sink = p.outputDeviceId;
  const play = (): void => void el.play().catch(() => undefined);
  if (sink) void el.setSinkId(sink).then(play, play);
  else play();
}
