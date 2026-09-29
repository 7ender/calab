// Shared by tools/gen-backgrounds.mjs and tools/import-backgrounds.mjs (ADR-0035): WebP encoding in
// Playwright's headless Chromium (no native image tooling needed), the size budget and the
// manifest the renderer reads (apps/desktop/src/renderer/assets/backgrounds/manifest.json).
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = resolve(here, '../apps/desktop/src/renderer/assets/backgrounds');
export const FULL = { width: 1280, height: 720 };
export const THUMB = { width: 320, height: 180 };
export const LOCALES = ['ru', 'en', 'es', 'zh-CN'];

/** Playwright lives in the desktop workspace. */
async function chromium() {
  const require = createRequire(join(here, '../apps/desktop/package.json'));
  const pw = await import(require.resolve('@playwright/test'));
  return pw.chromium ?? pw.default.chromium;
}

/**
 * Opens one headless Chromium page for a batch. `encode(fn, arg, maxBytes)` runs `fn(canvas, arg)`
 * in the page (a 2D canvas of FULL size is passed; `fn` may resize it) and returns WebP bytes
 * at the highest quality that fits `maxBytes`, and a THUMB-sized WebP of the same picture.
 */
export async function withEncoder(run) {
  const browser = await (await chromium()).launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><title>bg</title>');
    const encode = async (source, arg, maxBytes) => {
      const res = await page.evaluate(
        async ({ source, arg, maxBytes, full, thumb }) => {
          const draw = new Function('canvas', 'arg', `return (${source})(canvas, arg);`);
          const c = document.createElement('canvas');
          c.width = full.width;
          c.height = full.height;
          await draw(c, arg);
          const toWebp = (canvas, q) => new Promise((r) => canvas.toBlob((b) => r(b), 'image/webp', q));
          let blob = null;
          for (const q of [0.86, 0.8, 0.74, 0.68, 0.6, 0.52, 0.44, 0.36]) {
            blob = await toWebp(c, q);
            if (blob && blob.size <= maxBytes) break;
          }
          const t = document.createElement('canvas');
          t.width = thumb.width;
          t.height = thumb.height;
          const g = t.getContext('2d');
          g.imageSmoothingQuality = 'high';
          g.drawImage(c, 0, 0, thumb.width, thumb.height);
          const tb = await toWebp(t, 0.8);
          const b64 = async (b) => {
            const buf = new Uint8Array(await b.arrayBuffer());
            let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            return btoa(s);
          };
          return { full: await b64(blob), thumb: await b64(tb), size: blob.size };
        },
        { source: source.toString(), arg, maxBytes, full: FULL, thumb: THUMB },
      );
      if (res.size > maxBytes) throw new Error(`does not fit ${maxBytes} bytes even at the lowest quality`);
      return { full: Buffer.from(res.full, 'base64'), thumb: Buffer.from(res.thumb, 'base64') };
    };
    return await run(encode);
  } finally {
    await browser.close();
  }
}

/**
 * Writes the set: `<id>.webp` + `<id>.thumb.webp` per entry and manifest.json; removes images of
 * the previous set that the new manifest no longer lists.
 */
export function writeSet(entries) {
  const keep = new Set(['manifest.json']);
  for (const e of entries) {
    writeFileSync(join(OUT_DIR, e.file), e.fullBytes);
    writeFileSync(join(OUT_DIR, e.thumb), e.thumbBytes);
    keep.add(e.file);
    keep.add(e.thumb);
    console.log(`${e.file}  ${(e.fullBytes.length / 1024).toFixed(1)} KB   ${e.thumb}  ${(e.thumbBytes.length / 1024).toFixed(1)} KB`);
  }
  if (existsSync(OUT_DIR)) for (const f of readdirSync(OUT_DIR)) if (!keep.has(f)) rmSync(join(OUT_DIR, f));
  const manifest = entries.map(({ id, file, thumb, name }) => ({ id, file, thumb, name }));
  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest.json: ${entries.length} backgrounds → ${OUT_DIR}`);
}
