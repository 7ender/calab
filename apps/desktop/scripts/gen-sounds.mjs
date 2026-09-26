#!/usr/bin/env node
// New-message sound (docs/09 P1 #13): an original two-note «oh-oh» cue in the spirit of the classic
// messenger chime — our own pitches, glides and envelopes, not a copy of any existing sound.
// No dependencies: pure math → PCM → WAV (48 kHz, mono, 16-bit). Deterministic: the same
// command always writes byte-identical files (no randomness, no timestamps).
//
//   node scripts/gen-sounds.mjs                      → resources/sounds/message.wav (variant a)
//   node scripts/gen-sounds.mjs --variant b          → resources/sounds/message.wav from variant b
//   node scripts/gen-sounds.mjs --all --out <dir>    → <dir>/message-{a,b,c}.wav (candidates)
//
// Loudness: each clip is scaled to −14 LUFS (BS.1770 K-weighting, one block over the whole clip —
// the clip is shorter than the 400 ms gating block) and then capped at a −3 dBFS sample peak.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 48000;
const TARGET_LUFS = -14;
const PEAK_DBFS = -3;

/**
 * A note: pitch glides linearly from f0 to f1 over `dur` seconds (phase-continuous), with a
 * linear attack and a raised-cosine release over the note's last `release` seconds.
 * `wave`: 'sine' (+ harmonics h2/h3) or 'triangle' (band-limited, odd harmonics up to 7th).
 * `vibrato`: [rate Hz, depth as a fraction of the pitch].
 */
const VARIANTS = {
  // a — soft «о-оу»: sine with a touch of 2nd harmonic, gentle downward glides. 320 ms.
  a: [
    { at: 0, dur: 0.13, f0: 660, f1: 640, wave: 'sine', h2: 0.15, h3: 0, attack: 0.005, release: 0.07, gain: 1 },
    { at: 0.17, dur: 0.15, f0: 540, f1: 505, wave: 'sine', h2: 0.15, h3: 0, attack: 0.005, release: 0.12, gain: 0.95 },
  ],
  // b — shorter and brighter: a triangle wave, higher pitches, quicker tails. 280 ms.
  b: [
    { at: 0, dur: 0.1, f0: 880, f1: 860, wave: 'triangle', attack: 0.005, release: 0.05, gain: 1 },
    { at: 0.14, dur: 0.14, f0: 700, f1: 665, wave: 'triangle', attack: 0.005, release: 0.12, gain: 0.95 },
  ],
  // c — warm: lower, richer harmonics, a light 6 Hz vibrato on the second note. 340 ms.
  c: [
    { at: 0, dur: 0.13, f0: 620, f1: 600, wave: 'sine', h2: 0.28, h3: 0.08, attack: 0.006, release: 0.07, gain: 1 },
    { at: 0.17, dur: 0.17, f0: 500, f1: 470, wave: 'sine', h2: 0.28, h3: 0.08, attack: 0.006, release: 0.12, gain: 0.95, vibrato: [6, 0.008] },
  ],
};

function oscillator(wave, phase, h2 = 0, h3 = 0) {
  if (wave === 'triangle') {
    // Band-limited triangle: odd harmonics with alternating sign, 1/n² amplitudes.
    let v = 0;
    for (let n = 1, s = 1; n <= 7; n += 2, s = -s) v += (s * Math.sin(n * phase)) / (n * n);
    return (8 / (Math.PI * Math.PI)) * v;
  }
  return Math.sin(phase) + h2 * Math.sin(2 * phase) + h3 * Math.sin(3 * phase);
}

export function render(notes) {
  const end = notes.reduce((a, n) => Math.max(a, n.at + n.dur), 0);
  const out = new Float64Array(Math.round(end * SR));
  for (const n of notes) {
    const start = Math.round(n.at * SR);
    const len = Math.round(n.dur * SR);
    const att = Math.round(n.attack * SR);
    const rel = Math.round(n.release * SR);
    let phase = 0;
    for (let i = 0; i < len && start + i < out.length; i++) {
      const t = i / SR;
      let f = n.f0 + (n.f1 - n.f0) * (i / len);
      if (n.vibrato) f *= 1 + n.vibrato[1] * Math.sin(2 * Math.PI * n.vibrato[0] * t);
      const a = Math.min(1, i / att);
      const k = i - (len - rel);
      const r = k <= 0 ? 1 : 0.5 * (1 + Math.cos((Math.PI * k) / rel)); // raised cosine → 0 at the end
      out[start + i] += n.gain * a * r * oscillator(n.wave, phase, n.h2, n.h3);
      phase += (2 * Math.PI * f) / SR;
    }
  }
  return out;
}

/** Biquad (direct form I). */
function biquad(x, [b0, b1, b2], [a1, a2]) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Loudness (LUFS) of a mono clip at 48 kHz: BS.1770-4 K-weighting, one block over the clip. */
export function lufs(x) {
  const pre = biquad(x, [1.53512485958697, -2.69169618940638, 1.19839281085285], [-1.69065929318241, 0.73248077421585]);
  const k = biquad(pre, [1, -2, 1], [-1.99004745483398, 0.99007225036621]);
  let ms = 0;
  for (const v of k) ms += v * v;
  return -0.691 + 10 * Math.log10(ms / k.length);
}

export function normalise(x) {
  const gainLufs = 10 ** ((TARGET_LUFS - lufs(x)) / 20);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const gainPeak = 10 ** (PEAK_DBFS / 20) / peak;
  const g = Math.min(gainLufs, gainPeak);
  return x.map((v) => v * g);
}

export function wav(x) {
  const buf = Buffer.alloc(44 + x.length * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + x.length * 2, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  return buf;
}

function build(name) {
  const notes = VARIANTS[name];
  if (!notes) throw new Error(`unknown variant "${name}" (a, b, c)`);
  const pcm = normalise(render(notes));
  let peak = 0;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  const info = `${Math.round((pcm.length / SR) * 1000)} ms, ${lufs(pcm).toFixed(1)} LUFS, peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`;
  return { data: wav(pcm), info };
}

function main(argv) {
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const here = dirname(fileURLToPath(import.meta.url));
  if (argv.includes('--all')) {
    const dir = resolve(arg('--out') ?? join(here, '..', 'build', '.gen', 'sounds'));
    mkdirSync(dir, { recursive: true });
    for (const v of Object.keys(VARIANTS)) {
      const { data, info } = build(v);
      const file = join(dir, `message-${v}.wav`);
      writeFileSync(file, data);
      console.log(`${file}: ${info}`);
    }
    return;
  }
  const variant = arg('--variant') ?? 'a';
  const file = resolve(arg('--out') ?? join(here, '..', 'resources', 'sounds', 'message.wav'));
  mkdirSync(dirname(file), { recursive: true });
  const { data, info } = build(variant);
  writeFileSync(file, data);
  console.log(`${file} (variant ${variant}): ${info}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
