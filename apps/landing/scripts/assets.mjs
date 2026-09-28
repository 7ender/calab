// Regenerates landing images from the shared 2x (Retina) macOS window captures in docs/images/
// (also used by README): <file>-{dark,light}@2x.png, 2880×1742 (window 1440×871 pt), no shadow;
// <file>-{dark,light}-shadow@2x.png — same window with the system shadow (hero).
// mobile-dark@2x.png — the web client on an iPhone 14 (WebKit, 390 pt wide at 2x): its top part,
// rounded like a phone screen, centred on a transparent feature card (same art in both themes).
// Output (public/screens): <name>-<theme>@2x.webp at full resolution (no downscale) and
// <name>-<theme>.webp — a 1x Lanczos resample for non-Retina screens; plus public/og.png.
// Usage: pnpm -F @calaba/landing assets
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, '../../docs/images');
const out = join(root, 'public/screens');
const SCALE = 2;
const WEBP = { quality: 92, smartSubsample: true, effort: 6 };

// Crops in window points (1440×871); multiplied by SCALE. Feature crops share one 660×400 aspect.
const CROP = { width: 660, height: 400 };
const shots = [
  // hero: the whole window without the system shadow (the page draws a thin frame); a lower
  // quality keeps the 2x file under 250 KB
  { name: 'hero', file: 'chat', crop: null, webp: { quality: 80 } },
  // Feature rows (landing v2, docs/09 #97): mock-driven 1280×800 pt captures from
  // apps/desktop/e2e-marketing/landing.spec.ts, cropped to their subject at native size
  // (`native`: no resize to the 660×400 card).
  // voice: rooms column in a call (Борис speaking), the island and the noise popover
  { name: 'voice', file: 'landing-voice', native: true, crop: { left: 4, top: 300, width: 660, height: 494 } },
  // one-to-one call: the DM header «Звонок · 00:00 · Завершить» and the conversation
  { name: 'call', file: 'landing-call', native: true, crop: { left: 330, top: 38, width: 950, height: 600 } },
  // a done meeting recording: the card with the summary, «Ответить», «Полный транскрипт»
  { name: 'recording', file: 'landing-recording', native: true, crop: { left: 334, top: 276, width: 704, height: 344 } },
  // stream area only: streamer chip + LIVE and the shared screen
  { name: 'stream', file: 'stream', crop: { left: 344, top: 99, ...CROP } },
  // link preview + image message with a reaction
  { name: 'chat', file: 'chat', crop: { left: 331, top: 100, ...CROP } },
  // room settings → guest link: guest options, create button, active link
  { name: 'guests', file: 'settings', crop: { left: 482, top: 296, ...CROP } },
  // direct messages: the conversation list and the chat with Борис (a 1.5× wider area, scaled to fit)
  { name: 'dm', file: 'dm', crop: { left: 72, top: 36, width: 990, height: 600 } },
];

const scaled = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * SCALE)]));

await mkdir(out, { recursive: true });
for (const s of shots) {
  for (const theme of ['dark', 'light']) {
    const file = join(src, `${s.file}-${theme}${s.suffix ?? ''}@2x.png`);
    if (!existsSync(file)) throw new Error(`missing ${file}`);
    let img = sharp(file);
    if (s.crop) img = img.extract(scaled(s.crop));
    // Areas larger than a feature card are resampled once (Lanczos) to the card's 2x size.
    if (s.crop && !s.native && s.crop.width !== CROP.width) img = sharp(await img.png().toBuffer()).resize(CROP.width * SCALE, CROP.height * SCALE, { kernel: 'lanczos3' });
    const full = await img.png().toBuffer();
    const { width, height } = await sharp(full).metadata();
    const webp = { ...WEBP, ...s.webp };
    await sharp(full).webp(webp).toFile(join(out, `${s.name}-${theme}@2x.webp`));
    await sharp(full)
      .resize(Math.round(width / SCALE), Math.round(height / SCALE), { kernel: 'lanczos3' })
      .webp(webp)
      .toFile(join(out, `${s.name}-${theme}.webp`));
    console.log(`${s.name}-${theme}: ${width}×${height} @2x`);
  }
}

// Phone card: the top of the iPhone capture at 560 px (2x) wide, rounded like the screen (the
// bottom edge runs off the card), on a transparent 660×400 pt canvas; both themes share it.
{
  const phone = join(src, 'mobile-dark@2x.png');
  if (!existsSync(phone)) throw new Error(`missing ${phone}`);
  const W2 = CROP.width * SCALE;
  const H2 = CROP.height * SCALE;
  const PW = 560;
  const TOP = 48;
  const R = 64;
  const resized = await sharp(phone).resize(PW, null, { kernel: 'lanczos3' }).png().toBuffer();
  const ph = Math.min((await sharp(resized).metadata()).height, H2 - TOP);
  const mask = Buffer.from(`<svg width="${PW}" height="${ph}"><rect width="${PW}" height="${ph + R}" rx="${R}" ry="${R}"/></svg>`);
  const screen = await sharp(resized).extract({ left: 0, top: 0, width: PW, height: ph }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const frame = Buffer.from(
    `<svg width="${PW + 12}" height="${ph + 6}"><rect x="3" y="3" width="${PW + 6}" height="${ph + R}" rx="${R + 3}" ry="${R + 3}" fill="none" stroke="rgba(128,128,128,0.35)" stroke-width="4"/></svg>`,
  );
  const card = await sharp({ create: { width: W2, height: H2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: frame, left: Math.round((W2 - PW) / 2) - 6, top: TOP - 6 },
      { input: screen, left: Math.round((W2 - PW) / 2), top: TOP },
    ])
    .png()
    .toBuffer();
  for (const theme of ['dark', 'light']) {
    await sharp(card).webp(WEBP).toFile(join(out, `mobile-${theme}@2x.webp`));
    await sharp(card).resize(CROP.width, CROP.height, { kernel: 'lanczos3' }).webp(WEBP).toFile(join(out, `mobile-${theme}.webp`));
    console.log(`mobile-${theme}: ${W2}×${H2} @2x`);
  }
}

// Open Graph image 1200×630, composed from the 2x hero capture (single Lanczos downscale).
const W = 1200;
const H = 630;
const shotW = 960;
const heroMeta = await sharp(join(src, 'chat-dark@2x.png')).metadata();
const shotH = Math.round((shotW * heroMeta.height) / heroMeta.width);
const SHOT_TOP = 276;
const shot = await sharp(join(src, 'chat-dark@2x.png'))
  .resize(shotW, shotH, { kernel: 'lanczos3' })
  .composite([
    {
      input: Buffer.from(`<svg width="${shotW}" height="${shotH}"><rect width="${shotW}" height="${shotH}" rx="12" ry="12"/></svg>`),
      blend: 'dest-in',
    },
  ])
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
    { input: shot, left: W - shotW - 72, top: SHOT_TOP },
    { input: text, left: 0, top: 0 },
    { input: icon, left: 72, top: 60 },
  ])
  .png({ compressionLevel: 9 })
  .toFile(join(root, 'public/og.png'));

console.log('assets: public/screens/*.webp, public/og.png');
