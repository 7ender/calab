import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser } from '@playwright/test';
import type { Copy, PersonKey } from './copy';

/**
 * Pictures for the landing scenes, drawn by Chromium from HTML/SVG (deterministic, no binary
 * fixtures): people (avatars and camera frames over the app's own blurred room backgrounds), the
 * screen-share slide, the design mockup posted in the chat and emoji stickers.
 */

const BG_DIR = resolve(import.meta.dirname, '../src/renderer/assets/backgrounds');
const bgUrl = (id: string): string => `data:image/webp;base64,${readFileSync(resolve(BG_DIR, `${id}.webp`)).toString('base64')}`;

const FONT = `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', sans-serif`;

export async function render(browser: Browser, html: string, width: number, height: number, opts: { transparent?: boolean; scale?: number } = {}): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: opts.scale ?? 1 });
  try {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;${opts.transparent ? 'background:transparent;' : ''}font-family:${FONT};-webkit-font-smoothing:antialiased}</style></head><body>${html}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    return await page.screenshot({ type: 'png', omitBackground: opts.transparent === true });
  } finally {
    await page.close();
  }
}

interface Look {
  skin: string;
  hair: string;
  style: 'short' | 'long' | 'bun' | 'curly' | 'bob';
  shirt: string;
  /** Avatar tile colour and the camera's room background (the app's built-in pictures). */
  tint: string;
  room: string;
  glasses?: boolean;
  beard?: boolean;
}

export const LOOKS: Record<PersonKey, Look> = {
  anna: { skin: '#f1c7a8', hair: '#6b3f26', style: 'long', shirt: '#2f5d8a', tint: '#5b8def', room: 'bg-05' },
  boris: { skin: '#e2b08c', hair: '#2b2220', style: 'short', shirt: '#37474f', tint: '#f2994a', room: 'bg-06', beard: true },
  vera: { skin: '#f3d0b5', hair: '#1d1a1a', style: 'bob', shirt: '#8e5bd6', tint: '#bb6bd9', room: 'bg-02', glasses: true },
  grigory: { skin: '#c98e6b', hair: '#3a2a22', style: 'curly', shirt: '#2e7d5b', tint: '#27ae60', room: 'bg-04', glasses: true },
  dina: { skin: '#f5d6c0', hair: '#b5652f', style: 'bun', shirt: '#c0392b', tint: '#eb5757', room: 'bg-07' },
};

/** A flat head-and-shoulders figure in a 200×200 box (translated/scaled by the caller). */
function figure(l: Look): string {
  const hairBack = {
    long: `<path d="M58 88 C54 40 146 40 142 88 L146 150 C130 160 70 160 54 150 Z" fill="${l.hair}"/>`,
    bob: `<path d="M56 90 C52 38 148 38 144 90 L146 124 C128 132 72 132 54 124 Z" fill="${l.hair}"/>`,
    bun: `<circle cx="100" cy="30" r="20" fill="${l.hair}"/>`,
    short: '',
    curly: '',
  }[l.style];
  const hairTop = {
    long: `<path d="M60 90 C54 26 146 26 140 90 C130 64 96 56 60 90 Z" fill="${l.hair}"/>`,
    bob: `<path d="M58 92 C52 24 148 24 142 92 C130 64 90 54 58 92 Z" fill="${l.hair}"/>`,
    bun: `<path d="M62 84 C58 30 142 30 138 84 C124 62 86 58 62 84 Z" fill="${l.hair}"/>`,
    short: `<path d="M62 84 C58 30 142 30 138 84 C130 64 98 56 62 84 Z" fill="${l.hair}"/>`,
    curly: `<g fill="${l.hair}"><circle cx="72" cy="66" r="14"/><circle cx="88" cy="54" r="15"/><circle cx="106" cy="51" r="15"/><circle cx="123" cy="58" r="14"/><circle cx="133" cy="72" r="11"/><circle cx="66" cy="80" r="10"/></g>`,
  }[l.style];
  const glasses = l.glasses
    ? `<g fill="none" stroke="#1b1b1f" stroke-width="3"><rect x="72" y="86" width="22" height="16" rx="6"/><rect x="106" y="86" width="22" height="16" rx="6"/><path d="M94 93 L106 93"/></g>`
    : '';
  const beard = l.beard ? `<path d="M65 98 C66 146 134 146 135 98 C130 116 118 127 100 127 C82 127 70 116 65 98 Z" fill="${l.hair}" opacity="0.9"/>` : '';
  return `
    ${hairBack}
    <path d="M28 200 C30 158 60 142 100 142 C140 142 170 158 172 200 Z" fill="${l.shirt}"/>
    <rect x="88" y="118" width="24" height="30" rx="10" fill="${l.skin}"/>
    <ellipse cx="100" cy="92" rx="36" ry="42" fill="${l.skin}"/>
    <g fill="#2a1d18"><circle cx="86" cy="94" r="3.2"/><circle cx="114" cy="94" r="3.2"/></g><g fill="none" stroke="#2a1d18" stroke-opacity=".55" stroke-width="2.4" stroke-linecap="round"><path d="M79 83 Q86 79 93 82"/><path d="M107 82 Q114 79 121 83"/></g>
    <path d="M90 113 Q100 120 110 113" stroke="#9c5a48" stroke-width="3" fill="none" stroke-linecap="round"/>
    ${beard}
    ${hairTop}
    ${glasses}`;
}

/** A round-cropped avatar picture (the app masks it into a circle). */
export function avatarHtml(l: Look, size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 200 200">
    <rect width="200" height="200" fill="${l.tint}"/>
    <g transform="translate(10 22) scale(0.9)">${figure(l)}</g></svg>`;
}

/** A 1280×720 camera frame: the person in front of a softly blurred room. */
export function cameraHtml(l: Look): string {
  return `<div style="position:relative;width:1280px;height:720px;overflow:hidden">
    <img src="${bgUrl(l.room)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:blur(6px) brightness(0.92)">
    <svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:290px;top:40px" width="700" height="700" viewBox="0 0 200 200">${figure(l)}</svg>
  </div>`;
}

/** The release slide Вера shares (1280×720). */
export function slideHtml(c: Copy): string {
  const items = c.slide.items
    .map(
      (t, i) => `<li style="display:flex;align-items:center;gap:22px;margin:0 0 22px">
        <span style="width:38px;height:38px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;${
          i < c.slide.done ? 'background:#30d158;color:#06270f' : 'background:#2c2c34;color:#8e8e98;border:2px solid #3a3a44;box-sizing:border-box'
        }">${i < c.slide.done ? '✓' : ''}</span>
        <span style="font-size:34px;color:${i < c.slide.done ? '#f5f5f7' : '#c7c7cf'}">${t}</span></li>`,
    )
    .join('');
  return `<div style="width:1280px;height:720px;box-sizing:border-box;padding:72px 96px;background:linear-gradient(135deg,#15161c 0%,#1d2233 60%,#1a2a4a 100%);color:#f5f5f7;position:relative">
    <div style="font-size:26px;font-weight:600;color:#6fb1ff;letter-spacing:.02em">${c.slide.eyebrow}</div>
    <div style="font-size:76px;font-weight:700;margin:14px 0 44px;letter-spacing:-0.02em">${c.slide.title}</div>
    <ul style="list-style:none;padding:0;margin:0">${items}</ul>
    <div style="position:absolute;right:96px;bottom:64px;padding:14px 26px;border-radius:999px;background:#0a84ff;color:#fff;font-size:26px;font-weight:600">${c.slide.footer}</div>
    <div style="position:absolute;right:96px;top:72px;display:flex;gap:10px;align-items:center;font-size:24px;font-weight:700;color:#c7c7cf">
      <span style="width:34px;height:34px;border-radius:10px;background:#0a84ff;display:inline-block"></span>${c.company}</div>
  </div>`;
}

/** The home page mockup Вера posts in the chat (1600×1000): a landing hero with a product window. */
export function mockupHtml(c: Copy): string {
  const m = c.chat.mockup;
  const bars = [72, 54, 88, 40, 66]
    .map((w, i) => `<div style="height:14px;border-radius:7px;background:${i === 0 ? '#0a84ff' : '#2c2f3a'};width:${w}%;margin:0 0 16px"></div>`)
    .join('');
  return `<div style="width:1600px;height:900px;background:radial-gradient(70% 60% at 50% 0%,#1f3b6b 0%,#101217 70%);color:#f5f5f7;box-sizing:border-box;padding:40px 80px">
    <div style="display:flex;align-items:center;justify-content:space-between;font-size:24px">
      <div style="display:flex;align-items:center;gap:14px;font-weight:700;font-size:28px"><span style="width:40px;height:40px;border-radius:12px;background:#0a84ff;display:inline-block"></span>${c.company}</div>
      <div style="display:flex;gap:40px;color:#b8bcc8">${m.nav.map((n) => `<span>${n}</span>`).join('')}</div>
    </div>
    <div style="text-align:center;margin-top:70px">
      <div style="font-size:78px;font-weight:800;letter-spacing:-0.02em">${m.title}</div>
      <div style="font-size:32px;color:#b8bcc8;margin-top:22px">${m.lead}</div>
      <div style="display:flex;gap:18px;justify-content:center;margin-top:44px">
        <span style="padding:20px 40px;border-radius:999px;background:#0a84ff;font-size:26px;font-weight:600">${m.cta}</span>
        <span style="padding:20px 40px;border-radius:999px;background:rgba(10,132,255,.18);color:#6fb1ff;font-size:26px;font-weight:600">${m.secondary}</span>
      </div>
    </div>
    <div style="margin:56px auto 0;width:1080px;height:360px;border-radius:24px 24px 0 0;background:#1b1d24;border:2px solid #2c2f3a;border-bottom:0;display:flex;overflow:hidden">
      <div style="width:220px;background:#15171d;padding:34px 24px;box-sizing:border-box">${bars}</div>
      <div style="flex:1;padding:34px;box-sizing:border-box">
        <div style="display:flex;gap:16px;margin-bottom:26px">${['#5b8def', '#f2994a', '#bb6bd9'].map((col) => `<span style="width:44px;height:44px;border-radius:50%;background:${col};display:inline-block"></span>`).join('')}</div>
        <div style="height:18px;border-radius:9px;background:#2c2f3a;width:80%;margin-bottom:18px"></div>
        <div style="height:18px;border-radius:9px;background:#2c2f3a;width:62%;margin-bottom:18px"></div>
        <div style="height:18px;border-radius:9px;background:#2c2f3a;width:70%"></div>
      </div>
    </div>
  </div>`;
}

/** An emoji sticker (transparent, with a white outline like Telegram's). */
export function stickerHtml(emoji: string, size: number): string {
  const px = Math.round(size * 0.78);
  const o = Math.max(3, Math.round(size / 40));
  const shadow = [-o, 0, o].flatMap((x) => [-o, 0, o].map((y) => `${x}px ${y}px 0 #fff`)).join(',');
  return `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;font-size:${px}px;line-height:1;font-family:'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif;filter:drop-shadow(0 4px 6px rgba(0,0,0,.25));text-shadow:${shadow}">${emoji}</div>`;
}

/** A tiny valid one-page PDF (the chat shows name, size and an icon). */
export function pdfBytes(title: string): Buffer {
  const text = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n% ${title.replace(/[^\x20-\x7e]/g, '?')}\n${'% regression report line\n'.repeat(9000)}trailer<</Root 1 0 R>>\n%%EOF\n`;
  return Buffer.from(text, 'latin1');
}
