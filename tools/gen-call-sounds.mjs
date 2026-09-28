#!/usr/bin/env node
// One-to-one call sounds (ADR-0034): our own simple tones, no third-party audio. Pure math → PCM
// → WAV (16 kHz, mono, 16-bit). Deterministic: the same command writes byte-identical files.
//
//   node tools/gen-call-sounds.mjs   → apps/desktop/resources/sounds/call-{incoming,outgoing}.wav
//
// Each file is ONE ring of the cadence (≤ 50 KB); the pause between rings is the player's
// (lib/sounds.ts startRing), so the files carry no silence.
//   call-outgoing — the ring-back the caller hears: a 425 Hz tone, 1 s (the pause: 3 s).
//   call-incoming — the ringtone: a rising marimba-like phrase E5 G#5 B5 · E5 G#5 B5 E6, 1.3 s
//                   (the pause: 1 s).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 16000;
const PEAK = 0.5; // −6 dBFS: loud enough to be heard over a room, below the UI sounds' ceiling

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../apps/desktop/resources/sounds');

/** A steady tone with soft 25 ms edges (no clicks). */
function steady({ f, dur, h2 = 0.12 }) {
  const n = Math.round(dur * SR);
  const edge = Math.round(0.025 * SR);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * f * i) / SR;
    const env = Math.min(1, i / edge, (n - i) / edge);
    buf[i] = (Math.sin(w) + h2 * Math.sin(2 * w)) * env;
  }
  return buf;
}

/** Struck notes (fast attack, exponential decay), mixed. */
function struck(notes, dur) {
  const n = Math.round(dur * SR);
  const buf = new Float32Array(n);
  for (const { f, at, len, gain = 1 } of notes) {
    const start = Math.round(at * SR);
    const m = Math.round(len * SR);
    const attack = Math.round(0.004 * SR);
    const release = Math.round(0.02 * SR);
    const tau = len / 4;
    for (let i = 0; i < m && start + i < n; i++) {
      const tt = i / SR;
      const w = 2 * Math.PI * f * tt;
      // Marimba-ish: fundamental + a 4th harmonic that dies fast.
      const tone = Math.sin(w) + 0.25 * Math.sin(4 * w) * Math.exp(-tt / 0.03);
      const env = Math.min(1, i / attack) * Math.exp(-tt / tau) * Math.min(1, (m - i) / release);
      buf[start + i] += tone * env * gain;
    }
  }
  return buf;
}

function wav(buf) {
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const k = peak > 0 ? PEAK / peak : 0;
  const data = Buffer.alloc(44 + buf.length * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + buf.length * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(buf.length * 2, 40);
  for (let i = 0; i < buf.length; i++) data.writeInt16LE(Math.round(buf[i] * k * 32767), 44 + i * 2);
  return data;
}

const E5 = 659.25;
const GS5 = 830.61;
const B5 = 987.77;
const E6 = 1318.51;

const files = {
  'call-outgoing.wav': steady({ f: 425, dur: 1.0 }),
  'call-incoming.wav': struck(
    [
      { f: E5, at: 0, len: 0.3 },
      { f: GS5, at: 0.12, len: 0.3 },
      { f: B5, at: 0.24, len: 0.35 },
      { f: E5, at: 0.6, len: 0.3, gain: 0.9 },
      { f: GS5, at: 0.72, len: 0.3, gain: 0.9 },
      { f: B5, at: 0.84, len: 0.3, gain: 0.9 },
      { f: E6, at: 0.96, len: 0.34 },
    ],
    1.3,
  ),
};

mkdirSync(out, { recursive: true });
for (const [name, buf] of Object.entries(files)) {
  const bytes = wav(buf);
  if (bytes.length > 50 * 1024) throw new Error(`${name}: ${bytes.length} bytes > 50 KB`);
  writeFileSync(join(out, name), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
