// Regenerates landing images from the shared 2x (Retina) macOS window captures in docs/images/
// (also used by README): <file>-{dark,light}@2x.png, 2880×1742 (window 1440×871 pt), no shadow;
// <file>-{dark,light}-shadow@2x.png — same window with the system shadow (hero).
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
  { name: 'hero', file: 'chat', suffix: '-shadow', crop: null },
  // mode picker: step dots, title, VAD / PTT segmented control
  { name: 'voice', file: 'onboarding', crop: { left: 390, top: 140, ...CROP } },
  // stream area only: streamer chip + LIVE and the shared screen
  { name: 'stream', file: 'stream', crop: { left: 344, top: 99, ...CROP } },
  // link preview + image message with a reaction
  { name: 'chat', file: 'chat', crop: { left: 331, top: 100, ...CROP } },
  // room settings → guest link: guest options, create button, active link
  { name: 'guests', file: 'settings', crop: { left: 482, top: 296, ...CROP } },
];

const scaled = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * SCALE)]));

await mkdir(out, { recursive: true });
for (const s of shots) {
  for (const theme of ['dark', 'light']) {
    const file = join(src, `${s.file}-${theme}${s.suffix ?? ''}@2x.png`);
    if (!existsSync(file)) throw new Error(`missing ${file}`);
    let img = sharp(file);
    if (s.crop) img = img.extract(scaled(s.crop));
    const full = await img.png().toBuffer();
    const { width, height } = await sharp(full).metadata();
    await sharp(full).webp(WEBP).toFile(join(out, `${s.name}-${theme}@2x.webp`));
    await sharp(full)
      .resize(Math.round(width / SCALE), Math.round(height / SCALE), { kernel: 'lanczos3' })
      .webp(WEBP)
      .toFile(join(out, `${s.name}-${theme}.webp`));
    console.log(`${s.name}-${theme}: ${width}×${height} @2x`);
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
