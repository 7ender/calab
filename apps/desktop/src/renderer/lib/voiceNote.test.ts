import { describe, expect, it } from 'vitest';
import {
  CANCEL_DX,
  LOCK_DY,
  VOICE_BARS,
  VOICE_MAX_MS,
  WaveformBuilder,
  base64url,
  cancelProgress,
  drawBars,
  formatRecording,
  holdMove,
  holdRelease,
  isVoice,
  levelFromRms,
  voiceFileName,
  voiceQuery,
} from './voiceNote';

describe('levelFromRms', () => {
  it('maps −60..−6 dBFS to 0..1 and clamps', () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(0.001)).toBeCloseTo(0, 5); // −60 dBFS
    expect(levelFromRms(10 ** (-33 / 20))).toBeCloseTo(0.5, 5);
    expect(levelFromRms(1)).toBe(1);
    expect(levelFromRms(Number.NaN)).toBe(0);
  });
});

describe('WaveformBuilder', () => {
  it('keeps at most 100 bars, each the peak of its slice, normalised to 255', () => {
    const w = new WaveformBuilder();
    for (let i = 0; i < 1000; i++) w.push(i % 10 === 0 ? 0.5 : 0.1);
    const bars = w.bars();
    expect(bars.length).toBe(VOICE_BARS);
    expect(Math.max(...bars)).toBe(255);
    expect(bars.every((b) => b === 255)).toBe(true); // every slice of 10 holds one peak
  });
  it('short recordings give one bar per tick, silence stays flat', () => {
    const w = new WaveformBuilder();
    [0, 0.2, 0.4].forEach((v) => w.push(v));
    expect(Array.from(w.bars())).toEqual([0, 128, 255]);
    const quiet = new WaveformBuilder();
    quiet.push(0);
    quiet.push(0);
    expect(Array.from(quiet.bars())).toEqual([0, 0]);
    expect(new WaveformBuilder().bars().length).toBe(0);
  });
  it('clamps bad levels and keeps the tail for the live bars', () => {
    const w = new WaveformBuilder();
    [2, -1, Number.NaN, 0.5].forEach((v) => w.push(v));
    expect(w.tail(2)).toEqual([0, 0.5]);
    expect(w.tail(10)).toEqual([1, 0, 0, 0.5]);
  });
});

describe('drawBars', () => {
  it('resamples to the drawn count by peaks', () => {
    expect(drawBars(new Uint8Array([0, 255, 51, 102]), 2)).toEqual([1, 0.4]);
    expect(drawBars(new Uint8Array([255, 0]), 4)).toEqual([1, 1, 0, 0]);
    expect(drawBars(new Uint8Array(), 3)).toEqual([0, 0, 0]);
    expect(drawBars(new Uint8Array([1]), 0)).toEqual([]);
  });
});

describe('upload query', () => {
  it('base64url without padding (Go RawURLEncoding)', () => {
    expect(base64url(new Uint8Array([0, 10, 255]))).toBe('AAr_');
    expect(base64url(new Uint8Array([251, 255]))).toBe('-_8');
  });
  it('clamps the duration and the bars', () => {
    expect(voiceQuery({ durationMs: 4200.4, waveform: new Uint8Array([0, 10, 255]) })).toBe('?voice_duration_ms=4200&voice_waveform=AAr_');
    const q = voiceQuery({ durationMs: VOICE_MAX_MS + 5000, waveform: new Uint8Array(150) });
    expect(q).toContain(`voice_duration_ms=${VOICE_MAX_MS}`);
    expect(q.split('voice_waveform=')[1]?.length).toBe(Math.ceil((VOICE_BARS * 4) / 3));
  });
});

describe('isVoice', () => {
  it('is set by the server (FileMeta.voice)', () => {
    expect(isVoice({ voice: { durationMs: 1200 } })).toBe(true);
    expect(isVoice({ voice: { durationMs: 0 } })).toBe(false);
    expect(isVoice({ voice: undefined })).toBe(false);
    expect(isVoice({})).toBe(false);
  });
});

describe('names and timer', () => {
  it('file name from the local time', () => {
    expect(voiceFileName(new Date(2026, 8, 7, 5, 4, 3))).toBe('voice-2026-09-07-05-04-03.ogg');
  });
  it('timer with tenths', () => {
    expect(formatRecording(0)).toBe('0:00,0');
    expect(formatRecording(7450)).toBe('0:07,4');
    expect(formatRecording(299_999)).toBe('4:59,9');
    expect(formatRecording(-5)).toBe('0:00,0');
  });
});

describe('hold gesture', () => {
  it('slide left cancels, slide up locks, the dominant axis wins', () => {
    expect(holdMove('hold', -10, -10)).toBe('hold');
    expect(holdMove('hold', -CANCEL_DX, -5)).toBe('cancelled');
    expect(holdMove('hold', -5, -LOCK_DY)).toBe('locked');
    expect(holdMove('hold', -CANCEL_DX - 10, -LOCK_DY)).toBe('cancelled');
    expect(holdMove('hold', -LOCK_DY, -LOCK_DY - 20)).toBe('locked');
    expect(holdMove('hold', CANCEL_DX * 2, LOCK_DY * 2)).toBe('hold');
  });
  it('locked and cancelled are final', () => {
    expect(holdMove('locked', -CANCEL_DX * 2, 0)).toBe('locked');
    expect(holdMove('cancelled', 0, -LOCK_DY * 2)).toBe('cancelled');
  });
  it('release sends a held recording and keeps a locked one', () => {
    expect(holdRelease('hold')).toBe('send');
    expect(holdRelease('locked')).toBe('keep');
    expect(holdRelease('cancelled')).toBe('cancel');
  });
  it('the cancel hint follows the finger', () => {
    expect(cancelProgress(20)).toBe(0);
    expect(cancelProgress(-CANCEL_DX / 2)).toBe(0.5);
    expect(cancelProgress(-CANCEL_DX * 3)).toBe(1);
  });
});
