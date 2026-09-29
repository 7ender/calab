// Regenerates the landing and README images from the raw captures of
// apps/desktop/e2e-marketing/landing.spec.ts in apps/landing/shots/ (git-ignored):
// <shot>-<locale>-<theme>@2x.png — the renderer's 1440 pt wide window at 2x (as tall as the display
// allows, ~869 pt on a 14" MacBook), the UI in the landing locale (ru, en, es, zh → app zh-CN);
// mobile-<locale>-<theme>@2x.png — the web client on an iPhone 14 (WebKit, 390 pt wide at 2x).
// Output:
// - public/screens/<name>-<locale>-<theme>@2x.webp at full resolution (no downscale) and
//   <name>-<locale>-<theme>.webp — a 1x Lanczos resample; every file ≤ 250 KB (quality steps down).
//   A locale without captures gets the English files (the pages always find all four).
// - docs/images/readme/<name>.webp — README screenshots: ru, dark, whole window at 2x, ≤ 400 KB.
// - public/og.png — 1200×630, from the ru dark hero.
// Usage: pnpm -F @calaba/landing assets
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'shots');
const out = join(root, 'public/screens');
const readme = join(root, '../../docs/images/readme');
const SCALE = 2;
const LOCALES = ['ru', 'en', 'es', 'zh'];
const THEMES = ['dark', 'light'];
const MAX_LANDING = 250_000;
const MAX_README = 400_000;

// Crops in window points (1440 wide); multiplied by SCALE. width/height here are the CSS sizes in
// src/components/{hero,features}.tsx — change both together.
const shots = [
  // hero: the whole window with drawn traffic lights (the renderer capture has no native frame)
  { name: 'hero', file: 'hero', crop: null, lights: true },
  // voice: rooms column in a call (Борис speaking), the island and the noise popover
  { name: 'voice', file: 'voice', crop: { left: 0, top: 300, width: 720, height: 569 } },
  // stream: the expanded stage — streamer chip + LIVE, the shared slide
  { name: 'stream', file: 'stream', crop: { left: 334, top: 92, width: 862, height: 656 } },
  // camera: «Проверьте камеру» with «Фон» (light blur) and the workspace pictures
  { name: 'camera', file: 'camera', crop: { left: 272, top: 178, width: 896, height: 514 } },
  // chat: the feed with a forwarded message and the composer
  { name: 'chat', file: 'chat', crop: { left: 331, top: 392, width: 868, height: 477 } },
  // one-to-one call: the DM header «Звонок · 00:00 · Завершить» and the conversation
  { name: 'call', file: 'call', crop: { left: 330, top: 36, width: 1110, height: 620 } },
  // a done meeting recording: the play circle at 0:02, the summary, «Ответить», «Полный транскрипт»
  { name: 'recording', file: 'recording', crop: { left: 331, top: 284, width: 868, height: 346 } },
];

// README (ru, dark): whole windows, captions in README.md.
const readmeShots = [
  { name: 'chat', file: 'hero' },
  { name: 'stream', file: 'stream' },
  { name: 'call', file: 'call' },
  { name: 'recording', file: 'recording' },
  { name: 'camera', file: 'camera' },
  { name: 'badges', file: 'badges' },
  { name: 'mobile', file: 'mobile', phone: true },
];

const scaled = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * SCALE)]));

/** The capture for a locale, or the English one. */
function source(file, locale, theme) {
  for (const l of [locale, 'en']) {
    const p = join(src, `${file}-${l}-${theme}@2x.png`);
    if (existsSync(p)) return p;
  }
  throw new Error(`missing ${file}-${locale}-${theme}@2x.png (and the en fallback) in ${src}`);
}

/** macOS traffic lights over the title bar (points: 12 pt circles 20 pt apart, centred at y 18). */
async function withLights(buf) {
  const { width, height } = await sharp(buf).metadata();
  const dots = [
    ['#FF5F57', '#E14640'],
    ['#FEBC2E', '#DFA123'],
    ['#28C840', '#1DAD2B'],
  ]
    .map(([fill, stroke], i) => `<circle cx="${(20 + i * 20) * SCALE}" cy="${18 * SCALE}" r="${5.75 * SCALE}" fill="${fill}" stroke="${stroke}" stroke-width="${0.5 * SCALE}"/>`)
    .join('');
  return sharp(buf)
    .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${dots}</svg>`), left: 0, top: 0 }])
    .png()
    .toBuffer();
}

/** WebP at the highest quality (from `q`, step 4) that fits `max` bytes. */
async function webp(img, file, max, q = 90) {
  for (let quality = q; ; quality -= 4) {
    const buf = await sharp(img).webp({ quality, smartSubsample: true, effort: 6 }).toBuffer();
    if (buf.length <= max || quality <= 50) {
      if (buf.length > max) throw new Error(`${file}: ${buf.length} B > ${max} B at q${quality}`);
      await sharp(buf).toFile(file);
      return { size: buf.length, quality };
    }
  }
}

async function shot(s, locale, theme) {
  let buf = await sharp(source(s.file, locale, theme)).png().toBuffer();
  if (s.lights) buf = await withLights(buf);
  if (s.crop) buf = await sharp(buf).extract(scaled(s.crop)).png().toBuffer();
  return buf;
}

// Phone card: the top of the iPhone capture at 560 px (2x) wide, rounded like the screen (the
// bottom edge runs off the card), on a transparent 660×400 pt canvas.
async function phoneCard(file) {
  const W2 = 660 * SCALE;
  const H2 = 400 * SCALE;
  const PW = 560;
  const TOP = 48;
  const R = 64;
  const resized = await sharp(file).resize(PW, null, { kernel: 'lanczos3' }).png().toBuffer();
  const ph = Math.min((await sharp(resized).metadata()).height, H2 - TOP);
  const mask = Buffer.from(`<svg width="${PW}" height="${ph}"><rect width="${PW}" height="${ph + R}" rx="${R}" ry="${R}"/></svg>`);
  const screen = await sharp(resized).extract({ left: 0, top: 0, width: PW, height: ph }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const frame = Buffer.from(
    `<svg width="${PW + 12}" height="${ph + 6}"><rect x="3" y="3" width="${PW + 6}" height="${ph + R}" rx="${R + 3}" ry="${R + 3}" fill="none" stroke="rgba(128,128,128,0.35)" stroke-width="4"/></svg>`,
  );
  return sharp({ create: { width: W2, height: H2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: frame, left: Math.round((W2 - PW) / 2) - 6, top: TOP - 6 },
      { input: screen, left: Math.round((W2 - PW) / 2), top: TOP },
    ])
    .png()
    .toBuffer();
}

async function write(name, locale, theme, full) {
  const { width, height } = await sharp(full).metadata();
  const base = join(out, `${name}-${locale}-${theme}`);
  const a = await webp(full, `${base}@2x.webp`, MAX_LANDING);
  const one = await sharp(full).resize(Math.round(width / SCALE), Math.round(height / SCALE), { kernel: 'lanczos3' }).png().toBuffer();
  const b = await webp(one, `${base}.webp`, MAX_LANDING);
  console.log(`${name}-${locale}-${theme}: ${width}×${height} @2x ${(a.size / 1e3).toFixed(0)} KB q${a.quality} · 1x ${(b.size / 1e3).toFixed(0)} KB`);
}

// Old single-locale files (<name>-<theme>[@2x].webp) go: every screenshot is per locale now.
await mkdir(out, { recursive: true });
for (const f of await readdir(out)) if (/^[a-z]+-(dark|light)(@2x)?\.webp$/.test(f)) await rm(join(out, f));

for (const s of shots) for (const locale of LOCALES) for (const theme of THEMES) await write(s.name, locale, theme, await shot(s, locale, theme));
for (const locale of LOCALES) for (const theme of THEMES) await write('mobile', locale, theme, await phoneCard(source('mobile', locale, theme)));

await mkdir(readme, { recursive: true });
for (const r of readmeShots) {
  let buf = await sharp(source(r.file, 'ru', 'dark')).png().toBuffer();
  if (!r.phone) buf = await withLights(buf);
  const res = await webp(buf, join(readme, `${r.name}.webp`), MAX_README);
  console.log(`readme/${r.name}.webp: ${(res.size / 1e3).toFixed(0)} KB q${res.quality}`);
}

// Open Graph image 1200×630, composed from the 2x ru dark hero (single Lanczos downscale).
const W = 1200;
const H = 630;
const shotW = 960;
const hero = await withLights(await sharp(source('hero', 'ru', 'dark')).png().toBuffer());
const heroMeta = await sharp(hero).metadata();
const shotH = Math.round((shotW * heroMeta.height) / heroMeta.width);
const SHOT_TOP = 276;
const og = await sharp(hero)
  .resize(shotW, shotH, { kernel: 'lanczos3' })
  .composite([{ input: Buffer.from(`<svg width="${shotW}" height="${shotH}"><rect width="${shotW}" height="${shotH}" rx="12" ry="12"/></svg>`), blend: 'dest-in' }])
  .png()
  .toBuffer();
const text = Buffer.from(
  `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${W - shotW - 72 - 0.5}" y="${SHOT_TOP - 0.5}" width="${shotW + 1}" height="${shotH + 1}" rx="12.5" fill="none" stroke="rgba(255,255,255,0.14)"/>
    <text x="164" y="118" font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial" font-size="60" font-weight="700" fill="#F5F5F7">Calab</text>
    <text font-family="-apple-system, 'SF Pro Text', 'Helvetica Neue', Arial" font-size="30" font-weight="500" fill="#C7C7CC"><tspan x="72" y="184">Голосовые комнаты, чат и стрим экрана</tspan><tspan x="72" y="224">для команды — на вашем сервере</tspan></text>
  </svg>`,
);
const icon = await sharp(join(root, 'public/icon-512.png')).resize(72, 72, { kernel: 'lanczos3' }).png().toBuffer();
await sharp({ create: { width: W, height: H, channels: 3, background: '#1C1C1E' } })
  .composite([
    { input: og, left: W - shotW - 72, top: SHOT_TOP },
    { input: text, left: 0, top: 0 },
    { input: icon, left: 72, top: 60 },
  ])
  .png({ compressionLevel: 9 })
  .toFile(join(root, 'public/og.png'));

console.log('assets: public/screens/*.webp, docs/images/readme/*.webp, public/og.png');
