// Regenerates landing images from the desktop visual-regression snapshots.
// Usage: pnpm -F @calaba/landing assets   (then commit public/screens + public/og.png)
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, '../desktop/e2e-visual/__screenshots__/darwin');
const out = join(root, 'public/screens');

// Snapshots are 1440×800 @1x. Feature crops share one aspect (660×400) so cards line up.
const CROP = { width: 660, height: 400 };
const shots = [
  { name: 'hero', file: 'main-chat', crop: null },
  { name: 'voice', file: 'onboarding-mode', crop: { left: 390, top: 100, ...CROP } },
  { name: 'stream', file: 'voice-room-settings-2', crop: { left: 482, top: 82, ...CROP } },
  { name: 'chat', file: 'chat-context-menu', crop: { left: 331, top: 400, ...CROP } },
  { name: 'guests', file: 'room-settings-3', crop: { left: 482, top: 82, ...CROP } },
];

await mkdir(out, { recursive: true });
for (const s of shots) {
  for (const theme of ['dark', 'light']) {
    let img = sharp(join(src, `${s.file}-${theme}-1440.png`));
    if (s.crop) img = img.extract(s.crop);
    await img.webp({ quality: 90, smartSubsample: true }).toFile(join(out, `${s.name}-${theme}.webp`));
  }
}

// Open Graph image 1200×630: brand + tagline over the dark hero screenshot.
const W = 1200;
const H = 630;
const shotW = 960;
const SHOT_TOP = 276;
const shotH = Math.round((shotW * 800) / 1440);
const shot = await sharp(join(src, 'main-chat-dark-1440.png'))
  .resize(shotW, shotH)
  .composite([
    {
      input: Buffer.from(
        `<svg width="${shotW}" height="${shotH}"><rect width="${shotW}" height="${shotH}" rx="14" ry="14"/></svg>`,
      ),
      blend: 'dest-in',
    },
  ])
  .png()
  .toBuffer();
const frame = Buffer.from(
  `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${W - shotW - 72 - 0.5}" y="${SHOT_TOP - 0.5}" width="${shotW + 1}" height="${shotH + 1}" rx="14.5" fill="none" stroke="rgba(255,255,255,0.14)"/>
    <text x="164" y="118" font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial" font-size="60" font-weight="700" fill="#F5F5F7">Calab</text>
    <text font-family="-apple-system, 'SF Pro Text', 'Helvetica Neue', Arial" font-size="30" font-weight="500" fill="#C7C7CC"><tspan x="72" y="184">Голосовые комнаты, чат и стрим экрана</tspan><tspan x="72" y="224">для команды — на вашем сервере</tspan></text>
  </svg>`,
);
const icon = await sharp(await readFile(join(root, 'public/icon-192.png'))).resize(72, 72).png().toBuffer();
await sharp({ create: { width: W, height: H, channels: 3, background: '#1C1C1E' } })
  .composite([
    { input: shot, left: W - shotW - 72, top: SHOT_TOP },
    { input: frame, left: 0, top: 0 },
    { input: icon, left: 72, top: 60 },
  ])
  .png({ compressionLevel: 9 })
  .toFile(join(root, 'public/og.png'));

console.log('assets: public/screens/*.webp, public/og.png');
