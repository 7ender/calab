#!/usr/bin/env node
/**
 * Camera background edge quality and worker cost per variant (ADR-0035 addendum «края»): the app's
 * processor (e2e-media/bgProbePage.ts `shoot`) over a picture of a person in Chromium on the GPU,
 * one PNG of the processed 1280×720 output per variant and kind, plus the worker's stats.
 *
 *   node scripts/bg-quality.mjs --picture person.jpg --out <dir> [--models <dir with .tflite>] [--sway 12]
 *
 * --models: selfie_segmenter.tflite (square 256×256) and selfie_multiclass_256x256.tflite from
 * storage.googleapis.com/mediapipe-models (Apache-2.0); variants needing a missing one are skipped.
 */
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

/** CPU seconds used so far by Playwright's Chromium processes (macOS / Linux `ps`). */
function browserCpu() {
  let sum = 0;
  for (const line of execFileSync('ps', ['-A', '-o', 'time=,command=']).toString().split('\n')) {
    if (!line.includes('ms-playwright')) continue;
    const t = line.trim().split(/\s+/)[0] ?? '';
    const parts = t.split(/[:-]/).map(Number);
    sum += parts.reduce((acc, x) => acc * 60 + x, 0);
  }
  return sum;
}

const HERE = fileURLToPath(new URL('../e2e-media/', import.meta.url));
const arg = (k, d = '') => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const picture = arg('--picture');
const outDir = arg('--out');
const models = arg('--models');
const sway = Number(arg('--sway', '0'));
const only = arg('--only');
const kinds = arg('--kinds', 'image,blur-strong').split(',');
// --bench <s>: also the browser's CPU (% of one core) over <s> seconds per variant, after a 4 s warm-up.
const bench = Number(arg('--bench', '0'));
if (!picture || !outDir) throw new Error('--picture and --out are required');
mkdirSync(outDir, { recursive: true });

const VARIANTS = {
  // Shipped 2.0: landscape 256×144, joint bilateral at ¼, smoothstep(0.3, 0.7), 8/s, EMA τ 60 ms.
  v1: {},
  // Guided filter at ¼, applied with the full-resolution luma.
  guided: { refine: 'guided', eps: 0.002, edge: [0.25, 0.75] },
  'guided-12fps': { refine: 'guided', eps: 0.002, edge: [0.25, 0.75], segFps: 12 },
  square: { modelUrl: '/models/selfie_segmenter.tflite', modelInput: [256, 256] },
  'square-guided': { modelUrl: '/models/selfie_segmenter.tflite', modelInput: [256, 256], refine: 'guided', eps: 0.002, edge: [0.25, 0.75] },
  // The reference (vpalmisano/virtual-background): multiclass, smoothstep(0.6, 0.9), every frame.
  'multiclass-ref': { modelUrl: '/models/selfie_multiclass_256x256.tflite', modelInput: [256, 256], invert: true, edge: [0.6, 0.9], segFps: 15, emaTauMs: 48 },
  'multiclass-guided': { modelUrl: '/models/selfie_multiclass_256x256.tflite', modelInput: [256, 256], invert: true, refine: 'guided', eps: 0.002, edge: [0.25, 0.75] },
};

// --variants '{"name": {tune}}': extra variants (merged over the built-in ones).
if (arg('--variants')) Object.assign(VARIANTS, JSON.parse(arg('--variants')));

const work = mkdtempSync(join(tmpdir(), 'calab-bg-quality-'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.webp': 'image/webp', '.tflite': 'application/octet-stream', '.json': 'application/json' };
try {
  await build({ root: HERE, base: './', logLevel: 'warn', configFile: false, worker: { format: 'es' }, build: { outDir: work, emptyOutDir: true, target: 'es2022', rollupOptions: { input: join(HERE, 'bgProbe.html') } } });
  if (models) cpSync(models, join(work, 'models'), { recursive: true });
  const server = createServer((req, res) => {
    const path = normalize(join(work, decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')));
    if (!path.startsWith(work) || !existsSync(path) || !statSync(path).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ args: ['--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${m.type()}] ${m.text().slice(0, 200)}`);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/bgProbe.html`);
  await page.waitForFunction(() => '__probe' in globalThis);
  console.log('env', JSON.stringify(await page.evaluate(() => globalThis.__probe.env())));
  const pic = `data:image/jpeg;base64,${readFileSync(picture).toString('base64')}`;
  const summary = {};
  for (const [name, tune] of Object.entries(VARIANTS)) {
    if (only && !only.split(',').includes(name)) continue;
    if (tune.modelUrl && !existsSync(join(work, tune.modelUrl.slice(1)))) continue;
    for (const kind of kinds) {
      const settle = bench ? (bench + 5) * 1000 : 7000;
      const pending = page.evaluate(([k, p, t, s, ms]) => globalThis.__probe.shoot(k, p, t, s, ms), [kind, pic, tune, sway, settle]);
      let cpu = null;
      if (bench) {
        await new Promise((r) => setTimeout(r, 4000));
        const c0 = browserCpu();
        const t0 = Date.now();
        await new Promise((r) => setTimeout(r, bench * 1000));
        cpu = Math.round(((browserCpu() - c0) / ((Date.now() - t0) / 1000)) * 1000) / 10;
      }
      const r = await pending;
      r.cpu = cpu;
      writeFileSync(join(outDir, `bg-${name}-${kind}.png`), Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
      summary[`${name} ${kind}`] = { cpu: r.cpu, stats: r.stats, last: r.states.at(-1) };
      console.log(name, kind, `cpu ${r.cpu ?? '-'} %`, JSON.stringify(r.stats), JSON.stringify(r.states.at(-1)));
    }
  }
  writeFileSync(join(outDir, 'bg-quality.json'), JSON.stringify(summary, null, 2));
  await browser.close();
  server.close();
} finally {
  rmSync(work, { recursive: true, force: true });
}
