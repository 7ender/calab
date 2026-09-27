/**
 * Voice messages (docs/09 #43, docs/02 «Голосовые сообщения», docs/08 «Голосовые сообщения»):
 * limits, the waveform recorded alongside the audio, the upload query, the press-and-hold
 * gesture of the mic button. Pure (unit-tested in voiceNote.test.ts).
 */

/** Longest recording: stops (and sends) by itself at 5 min. */
export const VOICE_MAX_MS = 5 * 60 * 1000;
/** The server's cap (files.MaxVoiceBytes): ~24 kbit/s × 5 min ≈ 0.9 MB leaves room for VBR peaks. */
export const VOICE_MAX_BYTES = 1536 * 1024;
/** Shorter than this is a slip of the finger, not a message: dropped (Telegram does the same). */
export const VOICE_MIN_MS = 700;
/** Bars stored with the file (VoiceInfo.waveform). */
export const VOICE_BARS = 100;
/** Encoder settings (docs/02): Ogg/Opus mono 48 kHz, VoIP, 20 ms frames, VBR ~24 kbit/s. */
export const VOICE_ENCODER = {
  encoderSampleRate: 48000,
  encoderApplication: 2048, // OPUS_APPLICATION_VOIP
  encoderFrameSize: 20,
  encoderBitRate: 24000,
  encoderComplexity: 10,
  numberOfChannels: 1,
  maxFramesPerPage: 50, // one Ogg page per second: ~0.3 % container overhead
  resampleQuality: 3,
} as const;
export const VOICE_MIME = 'audio/ogg';

/** A level for the meter and the waveform, 0..1, from a linear RMS: −60 dBFS → 0, −6 dBFS → 1. */
export function levelFromRms(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 54));
}

/**
 * Collects levels while recording (one per analysis tick) and turns them into ≤ 100 bars 0..255:
 * each bar is the loudest level of its slice of the recording, the loudest bar is 255 (the
 * shape matters, not the absolute loudness — Telegram normalises too).
 */
export class WaveformBuilder {
  private readonly levels: number[] = [];

  push(level: number): void {
    this.levels.push(Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0);
  }

  get length(): number {
    return this.levels.length;
  }

  /** The last `n` levels (the live bars while recording), oldest first. */
  tail(n: number): number[] {
    return this.levels.slice(Math.max(0, this.levels.length - n));
  }

  bars(count = VOICE_BARS): Uint8Array {
    const src = this.levels;
    const n = Math.min(count, src.length);
    const out = new Uint8Array(n);
    if (n === 0) return out;
    for (let i = 0; i < n; i++) {
      const from = Math.floor((i * src.length) / n);
      const to = Math.max(from + 1, Math.floor(((i + 1) * src.length) / n));
      let peak = 0;
      for (let j = from; j < to; j++) peak = Math.max(peak, src[j] ?? 0);
      out[i] = Math.round(peak * 255);
    }
    const top = out.reduce((m, v) => Math.max(m, v), 0);
    if (top > 0 && top < 255) for (let i = 0; i < n; i++) out[i] = Math.round(((out[i] ?? 0) * 255) / top);
    return out;
  }
}

/**
 * The stored waveform resampled to `count` bars for drawing (0..1 each): fewer bars take the
 * peak of their slice, more bars repeat. An empty waveform draws a flat line.
 */
export function drawBars(waveform: Uint8Array, count: number): number[] {
  const out: number[] = [];
  if (count <= 0) return out;
  if (waveform.length === 0) return Array.from({ length: count }, () => 0);
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * waveform.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * waveform.length) / count));
    let peak = 0;
    for (let j = from; j < to; j++) peak = Math.max(peak, waveform[j] ?? 0);
    out.push(peak / 255);
  }
  return out;
}

/** base64url without padding (the server's RawURLEncoding). */
export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface VoiceMeta {
  durationMs: number;
  waveform: Uint8Array;
}

/** `?voice_duration_ms=…&voice_waveform=…` of a voice upload (proto VoiceInfo). */
export function voiceQuery(v: VoiceMeta): string {
  const ms = Math.min(VOICE_MAX_MS, Math.max(1, Math.round(v.durationMs)));
  return `?voice_duration_ms=${ms}&voice_waveform=${base64url(v.waveform.subarray(0, VOICE_BARS))}`;
}

/** A voice message attachment (the server set FileMeta.voice). */
export function isVoice(f: { voice?: { durationMs: number } | undefined }): boolean {
  return !!f.voice && f.voice.durationMs > 0;
}

/** `voice-2026-09-27-15-04-05.ogg` (local time). */
export function voiceFileName(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `voice-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.ogg`;
}

/** Recording timer: «0:07,4» (tenths, like Telegram). */
export function formatRecording(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 100));
  const s = Math.floor(t / 10);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')},${t % 10}`;
}

// ---------------------------------------------------------------- the hold gesture

/** Slide this far left (px) while holding to cancel; up this far to lock. */
export const CANCEL_DX = 120;
export const LOCK_DY = 64;

export type HoldState = 'hold' | 'locked' | 'cancelled';

/**
 * Press-and-hold on the mic button (Telegram): holding records; sliding left past CANCEL_DX
 * cancels; sliding up past LOCK_DY locks (recording goes on without holding). Dominant axis
 * decides, so a diagonal drift does not do both. Once locked or cancelled it stays so.
 */
export function holdMove(state: HoldState, dx: number, dy: number): HoldState {
  if (state !== 'hold') return state;
  if (-dx >= CANCEL_DX && -dx >= -dy) return 'cancelled';
  if (-dy >= LOCK_DY && -dy > -dx) return 'locked';
  return state;
}

/** What releasing the button does: a held recording is sent, a locked one goes on. */
export function holdRelease(state: HoldState): 'send' | 'keep' | 'cancel' {
  return state === 'hold' ? 'send' : state === 'locked' ? 'keep' : 'cancel';
}

/** How far the «slide to cancel» hint follows the finger (0..1 of the way to CANCEL_DX). */
export function cancelProgress(dx: number): number {
  return Math.min(1, Math.max(0, -dx / CANCEL_DX));
}
