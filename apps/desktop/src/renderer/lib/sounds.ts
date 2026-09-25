import { prefs } from '../stores/prefs';

/**
 * UI sounds (join/leave/mute). Played through a plain <audio> element on the
 * selected output device — never through WebAudio, so AEC3 sees them as
 * WebRTC-independent playback exactly like any other system sound (echo rule 1).
 */
type SoundName = 'join' | 'leave' | 'mute' | 'unmute' | 'message';

const TONES: Record<SoundName, Array<[number, number]>> = {
  join: [[660, 0.07], [880, 0.1]],
  leave: [[880, 0.07], [587, 0.1]],
  mute: [[440, 0.06]],
  unmute: [[587, 0.06]],
  message: [[988, 0.05], [1319, 0.07]],
};

const cache = new Map<SoundName, string>();

function wav(notes: Array<[number, number]>): string {
  const sr = 24000;
  const total = notes.reduce((a, [, d]) => a + Math.round(d * sr), 0);
  const dv = new DataView(new ArrayBuffer(44 + total * 2));
  const w = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  dv.setUint32(4, 36 + total * 2, true);
  w(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, total * 2, true);
  let off = 44;
  for (const [f, d] of notes) {
    const n = Math.round(d * sr);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 200, (n - i) / 400); // click-free fade in/out
      dv.setInt16(off, Math.sin((2 * Math.PI * f * i) / sr) * 6000 * env, true);
      off += 2;
    }
  }
  return URL.createObjectURL(new Blob([dv.buffer], { type: 'audio/wav' }));
}

export function playSound(name: SoundName): void {
  const p = prefs();
  if (!p.voiceSounds && name !== 'message') return;
  let url = cache.get(name);
  if (!url) {
    url = wav(TONES[name]);
    cache.set(name, url);
  }
  const el = new Audio(url);
  el.volume = 0.5;
  const sink = p.outputDeviceId;
  const play = (): void => void el.play().catch(() => undefined);
  if (sink) void el.setSinkId(sink).then(play, play);
  else play();
}
