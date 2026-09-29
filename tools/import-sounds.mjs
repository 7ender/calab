#!/usr/bin/env node
// Replaces the built-in soundboard clips with the audio files in a folder (ADR-0036 §2). A file
// drop, no code change: the renderer reads apps/desktop/src/renderer/assets/sounds/manifest.json.
//
//   node tools/import-sounds.mjs <dir> [--source "<where the clips come from>"]
//
// <dir>: MP3 / WAV / Ogg / FLAC / M4A files, sorted by file name. Each becomes Ogg/Opus 48 kHz
// mono, loudness-normalised to −16 LUFS (EBU R128, true peak −1.5 dBTP), cut to 5 s, ≤ 200 KB —
// the same conversion the server applies to workspace sounds (files.SoundArgs). Needs ffmpeg with
// libopus in PATH.
//
// Ids come from the file name ("Air Horn.mp3" → air_horn). Emoji and captions, first found wins:
// <dir>/names.json { "<id>": { "emoji": "📯", "ru": …, "en": …, "es": …, "zh-CN": … } }, the
// current manifest entry of the same id, a leading emoji in the file name ("📯 air horn.mp3"),
// else 🔊 and the file name. The previous clips are removed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES = ['ru', 'en', 'es', 'zh-CN'];
const TYPES = new Set(['.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac', '.m4a']);
const MAX_BYTES = 200 * 1024;
const MAX_MS = 5000;

const here = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = resolve(here, '../apps/desktop/src/renderer/assets/sounds');
const MANIFEST = join(OUT_DIR, 'manifest.json');

/** "📯 Air Horn" → { emoji: "📯", base: "Air Horn" }. */
export function splitEmoji(name) {
  const m = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*(.*)$/u.exec(name);
  return m ? { emoji: m[1], base: m[2] } : { emoji: '', base: name };
}

/** "Air Horn!" → "air_horn". */
export const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 32) || 'sound';

/** "air_horn" → "Air horn". */
const caption = (s) => {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Duration of an Ogg/Opus stream in ms: last granule position − pre-skip, at 48 kHz. */
export function oggOpusMs(buf) {
  if (buf.subarray(0, 4).toString('latin1') !== 'OggS') return 0;
  const first = 27 + buf[26];
  if (buf.subarray(first, first + 8).toString('latin1') !== 'OpusHead') return 0;
  const preSkip = buf.readUInt16LE(first + 10);
  let last = -1n;
  for (let off = 0; off + 27 <= buf.length; ) {
    if (buf.subarray(off, off + 4).toString('latin1') !== 'OggS') return 0;
    const segs = buf[off + 26];
    let body = 0;
    for (let i = 0; i < segs; i++) body += buf[off + 27 + i];
    const g = buf.readBigInt64LE(off + 6);
    if (g >= 0n) last = g;
    off += 27 + segs + body;
  }
  return last < BigInt(preSkip) ? 0 : Number(((last - BigInt(preSkip)) * 1000n) / 48000n);
}

function convert(src, out) {
  execFileSync(
    'ffmpeg',
    [
      ...['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-t', '5', '-i', src],
      ...['-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1'],
      ...['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000', '-ac', '1', '-ar', '48000'],
      ...['-c:a', 'libopus', '-b:a', '96k', '-application', 'audio', '-f', 'ogg', out],
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

function main() {
  const args = process.argv.slice(2);
  const si = args.indexOf('--source');
  const source = si >= 0 ? args.splice(si, 2)[1] : '';
  const dir = args[0];
  if (!dir) {
    console.error('usage: node tools/import-sounds.mjs <dir> [--source "<origin>"]');
    process.exit(2);
  }
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-h', 'encoder=libopus'], { stdio: 'ignore' });
  } catch {
    console.error('ffmpeg with libopus is required (brew install ffmpeg / apt-get install ffmpeg)');
    process.exit(1);
  }
  const src = resolve(dir);
  const files = readdirSync(src)
    .filter((f) => TYPES.has(extname(f).toLowerCase()) && statSync(join(src, f)).isFile())
    .sort();
  if (!files.length) {
    console.error(`no audio files in ${src}`);
    process.exit(1);
  }
  const namesFile = join(src, 'names.json');
  const names = existsSync(namesFile) ? JSON.parse(readFileSync(namesFile, 'utf8')) : {};
  const previous = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { sounds: [] };
  const prevById = new Map((previous.sounds ?? []).map((e) => [e.id, e]));

  const tmp = mkdtempSync(join(tmpdir(), 'calaba-sounds-'));
  const used = new Set();
  const entries = [];
  try {
    for (const f of files) {
      const { emoji: fileEmoji, base } = splitEmoji(f.replace(/\.[^.]+$/, ''));
      let id = slug(base);
      for (let n = 2; used.has(id); n++) id = `${slug(base)}_${n}`;
      used.add(id);
      const out = join(tmp, `${id}.ogg`);
      convert(join(src, f), out);
      const clip = readFileSync(out);
      const ms = Math.min(oggOpusMs(clip), MAX_MS);
      if (ms < 1 || clip.length > MAX_BYTES) throw new Error(`${f}: ${ms} ms, ${clip.length} bytes after conversion`);
      const given = names[id] ?? {};
      const prev = prevById.get(id);
      const name = Object.fromEntries(LOCALES.map((l) => [l, given[l] ?? prev?.name?.[l] ?? given.en ?? prev?.name?.en ?? caption(base)]));
      entries.push({
        id,
        file: `${id}.ogg`,
        emoji: given.emoji ?? prev?.emoji ?? (fileEmoji || '🔊'),
        name,
        durationMs: ms,
        source: source || given.source || prev?.source || '',
        clip,
      });
    }
    mkdirSync(OUT_DIR, { recursive: true });
    for (const f of readdirSync(OUT_DIR)) if (f.endsWith('.ogg')) rmSync(join(OUT_DIR, f));
    for (const e of entries) writeFileSync(join(OUT_DIR, e.file), e.clip);
    const manifest = { sounds: entries.map(({ clip: _clip, ...e }) => e) };
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const e of entries) console.log(`${e.emoji} ${e.id}: ${e.durationMs} ms`);
  console.log(`imported ${entries.length} sounds into ${OUT_DIR}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
