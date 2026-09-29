#!/usr/bin/env node
// Fallback soundboard clips (ADR-0036 §2): our own synthesized stand-ins — no third-party audio —
// for when no real clips are at hand. It only writes WAVs; the built-in set is whatever
// tools/import-sounds.mjs imported last (the owner's clips now), so this is a two-step fallback:
//
//   node tools/gen-sounds.mjs <dir>          → <dir>/<emoji> <name>.wav (8 clips, ≤ 1.5 s)
//   node tools/import-sounds.mjs <dir> --source "synthesized (tools/gen-sounds.mjs)"
//
// Pure math → 48 kHz mono 16-bit PCM; deterministic (a fixed-seed noise generator).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SR = 48000;

/** Deterministic white noise in [-1, 1]. */
function noise(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
}

const buffer = (sec) => new Float32Array(Math.round(sec * SR));
const env = (t, attack, decay) => Math.min(1, t / attack) * Math.exp(-t / decay);

function add(buf, at, fn, len) {
  const start = Math.round(at * SR);
  const n = Math.min(Math.round(len * SR), buf.length - start);
  for (let i = 0; i < n; i++) buf[start + i] += fn(i / SR);
}

const CLIPS = {
  '🥁 drum_hit': () => {
    const b = buffer(1.2);
    const rnd = noise(7);
    // Two toms and a cymbal: «ba dum tss».
    add(b, 0, (t) => Math.sin(2 * Math.PI * (180 - 60 * t) * t) * env(t, 0.002, 0.12), 0.35);
    add(b, 0.22, (t) => Math.sin(2 * Math.PI * (140 - 40 * t) * t) * env(t, 0.002, 0.14), 0.4);
    add(b, 0.5, (t) => rnd() * 0.5 * env(t, 0.003, 0.25), 0.7);
    return b;
  },
  '🔔 ding': () => {
    const b = buffer(1.4);
    add(b, 0, (t) => (Math.sin(2 * Math.PI * 1318.5 * t) + 0.4 * Math.sin(2 * Math.PI * 2637 * t)) * env(t, 0.003, 0.35), 1.4);
    return b;
  },
  '🦆 quack': () => {
    const b = buffer(0.5);
    add(b, 0, (t) => {
      const f = 420 - 180 * t;
      let v = 0;
      for (let k = 1; k <= 8; k++) v += Math.sin(2 * Math.PI * f * k * t) / k; // buzzy saw
      return v * 0.45 * Math.min(1, t / 0.01) * Math.min(1, (0.28 - t) / 0.04);
    }, 0.28);
    return b;
  },
  '👏 applause': () => {
    const b = buffer(1.5);
    const rnd = noise(11);
    for (let k = 0; k < 28; k++) {
      const at = (k * 0.047 + ((k * 37) % 11) * 0.004) % 1.3;
      add(b, at, (t) => rnd() * env(t, 0.001, 0.018) * 0.8, 0.08);
    }
    return b;
  },
  '💨 whoosh': () => {
    const b = buffer(0.9);
    const rnd = noise(3);
    let lp = 0;
    add(b, 0, (t) => {
      const a = 0.02 + 0.3 * Math.sin((Math.PI * t) / 0.9); // a sweeping one-pole low-pass
      lp += a * (rnd() - lp);
      return lp * 2.2 * Math.sin((Math.PI * t) / 0.9);
    }, 0.9);
    return b;
  },
  '🪀 boing': () => {
    const b = buffer(1.0);
    add(b, 0, (t) => Math.sin(2 * Math.PI * (220 + 90 * Math.sin(2 * Math.PI * 7 * t) * Math.exp(-t * 3)) * t) * env(t, 0.004, 0.35), 1.0);
    return b;
  },
  '🎉 tada': () => {
    const b = buffer(1.5);
    const chord = [523.25, 659.25, 783.99, 1046.5];
    add(b, 0, (t) => Math.sin(2 * Math.PI * 392 * t) * env(t, 0.004, 0.08), 0.15);
    for (const f of chord) add(b, 0.16, (t) => (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * env(t, 0.006, 0.5) * 0.5, 1.3);
    return b;
  },
  '🚫 buzzer': () => {
    const b = buffer(0.8);
    add(b, 0, (t) => Math.sign(Math.sin(2 * Math.PI * 110 * t)) * 0.35 * Math.min(1, t / 0.01, (0.75 - t) / 0.03), 0.75);
    return b;
  },
};

function wav(samples) {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.7 / peak : 0;
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => out.writeInt16LE(Math.round(v * g * 32767), 44 + i * 2));
  return out;
}

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/gen-sounds.mjs <dir>');
  process.exit(2);
}
const out = resolve(dir);
mkdirSync(out, { recursive: true });
for (const [name, make] of Object.entries(CLIPS)) writeFileSync(join(out, `${name}.wav`), wav(make()));
console.log(`wrote ${Object.keys(CLIPS).length} clips to ${out}; now: node tools/import-sounds.mjs ${dir}`);
