#!/usr/bin/env node
// Replaces the built-in camera backgrounds with the pictures in a folder (ADR-0035 §4, docs/02
// «Камера: фон» — the picture spec). A file drop, no code change: the renderer reads manifest.json.
//
//   node tools/import-backgrounds.mjs <dir>
//
// <dir>: JPEG / PNG / WebP, 16:9 (other ratios are centre-cropped to 16:9), 1920×1080 source
// recommended. Sorted by file name; the file name (without extension) becomes the id. Optional
// <dir>/names.json gives the captions: { "<file name>": { "ru": …, "en": …, "es": …, "zh-CN": … } };
// without it every language gets the file name. Each picture → 1280×720 WebP ≤ 150 KB and a
// 320×180 thumbnail in apps/desktop/src/renderer/assets/backgrounds/, manifest.json rewritten,
// the previous set removed.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { FULL, LOCALES, OUT_DIR, withEncoder, writeSet } from './backgrounds-lib.mjs';

const MAX_BYTES = 150 * 1024;
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/import-backgrounds.mjs <dir>');
  process.exit(2);
}
const src = resolve(dir);
const files = readdirSync(src)
  .filter((f) => TYPES[extname(f).toLowerCase()])
  .sort();
if (!files.length) {
  console.error(`no JPEG / PNG / WebP in ${src}`);
  process.exit(1);
}
const namesFile = join(src, 'names.json');
const names = existsSync(namesFile) ? JSON.parse(readFileSync(namesFile, 'utf8')) : {};

/** Draws the data-URL picture centre-cropped to 16:9 into the 1280×720 canvas. */
async function cover(canvas, arg) {
  const img = new Image();
  img.src = arg.url;
  await img.decode();
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  const want = canvas.width / canvas.height;
  const have = img.naturalWidth / img.naturalHeight;
  const sw = have > want ? img.naturalHeight * want : img.naturalWidth;
  const sh = have > want ? img.naturalHeight : img.naturalWidth / want;
  g.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
}

const slug = (f) =>
  f
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'bg';

mkdirSync(OUT_DIR, { recursive: true });
const used = new Set();
const entries = await withEncoder(async (encode) => {
  const out = [];
  for (const f of files) {
    let id = slug(f);
    for (let n = 2; used.has(id); n++) id = `${slug(f)}-${n}`;
    used.add(id);
    const url = `data:${TYPES[extname(f).toLowerCase()]};base64,${readFileSync(join(src, f)).toString('base64')}`;
    const { full, thumb } = await encode(cover, { url }, MAX_BYTES);
    const given = names[f] ?? {};
    const base = f.replace(/\.[^.]+$/, '');
    const name = Object.fromEntries(LOCALES.map((l) => [l, given[l] ?? given['en'] ?? base]));
    out.push({ id, file: `${id}.webp`, thumb: `${id}.thumb.webp`, name, fullBytes: full, thumbBytes: thumb });
  }
  return out;
});
writeSet(entries);
console.log(`imported ${entries.length} pictures at ${FULL.width}×${FULL.height}`);
