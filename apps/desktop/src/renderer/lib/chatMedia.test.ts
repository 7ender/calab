import { describe, expect, it } from 'vitest';
import { formatTime, mediaKind, nextRate, seekPosition, trackInfo } from './chatMedia';

describe('mediaKind', () => {
  it('detects audio by extension', () => {
    for (const name of ['a.mp3', 'b.OGG', 'c.m4a', 'd.wav', 'e.flac', 'f.opus']) {
      expect(mediaKind({ mime: 'application/octet-stream', name })).toBe('audio');
    }
  });
  it('detects video by extension', () => {
    for (const name of ['a.mp4', 'b.webm', 'c.MOV']) {
      expect(mediaKind({ mime: 'application/octet-stream', name })).toBe('video');
    }
  });
  it('falls back to the MIME type without a known extension', () => {
    expect(mediaKind({ mime: 'audio/mpeg', name: 'track' })).toBe('audio');
    expect(mediaKind({ mime: 'audio/x-wav; codecs=1', name: 'rec.bin' })).toBe('audio');
    expect(mediaKind({ mime: 'video/quicktime', name: 'clip' })).toBe('video');
  });
  it('the extension wins over the MIME type', () => {
    expect(mediaKind({ mime: 'video/ogg', name: 'song.ogg' })).toBe('audio');
  });
  it('leaves other files alone', () => {
    expect(mediaKind({ mime: 'application/pdf', name: 'report.pdf' })).toBeNull();
    expect(mediaKind({ mime: 'audio/midi', name: 'tune.mid' })).toBeNull();
    expect(mediaKind({ mime: 'video/x-msvideo', name: 'old.avi' })).toBeNull();
    expect(mediaKind({ mime: '', name: '.mp3' })).toBeNull();
  });
});

describe('trackInfo', () => {
  it('splits «Artist - Title»', () => {
    expect(trackInfo('Daft Punk - One More Time.mp3')).toEqual({ title: 'One More Time', performer: 'Daft Punk' });
    expect(trackInfo('Кино — Группа крови.flac')).toEqual({ title: 'Группа крови', performer: 'Кино' });
  });
  it('uses the bare name otherwise', () => {
    expect(trackInfo('standup_notes.m4a')).toEqual({ title: 'standup notes', performer: '' });
    expect(trackInfo('a-b.mp3')).toEqual({ title: 'a-b', performer: '' });
    expect(trackInfo('noext')).toEqual({ title: 'noext', performer: '' });
  });
});

describe('formatTime', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(7.9)).toBe('0:07');
    expect(formatTime(205)).toBe('3:25');
    expect(formatTime(3723)).toBe('1:02:03');
  });
  it('unknown durations', () => {
    expect(formatTime(Number.NaN)).toBe('--:--');
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('--:--');
    expect(formatTime(-1)).toBe('--:--');
  });
});

describe('rates and seeking', () => {
  it('cycles 1× → 1.5× → 2× → 1×', () => {
    expect(nextRate(1)).toBe(1.5);
    expect(nextRate(1.5)).toBe(2);
    expect(nextRate(2)).toBe(1);
  });
  it('maps a pointer to a clamped position', () => {
    expect(seekPosition(150, 100, 200, 60)).toBe(15);
    expect(seekPosition(50, 100, 200, 60)).toBe(0);
    expect(seekPosition(400, 100, 200, 60)).toBe(60);
    expect(seekPosition(150, 100, 0, 60)).toBe(0);
    expect(seekPosition(150, 100, 200, Number.NaN)).toBe(0);
  });
});
