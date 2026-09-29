import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { build } from 'vite';

/**
 * Camera background on the wire (ADR-0035 §7) against the dev LiveKit (`pnpm infra:dev`): the app's
 * own processor (worker + MediaPipe + WebGL, bundled by Vite like the app) processes Chromium's
 * fake camera, the processed track is published, and a second browser subscribes and decodes it.
 * Chromium's fake camera has no person, so the whole frame is «background»: strong blur must
 * flatten its detail (edge energy), a picture must replace it (average luminance of the picture).
 *
 *   pnpm -F @calaba/desktop e2e:media -g background
 *   BG_LOOK_DIR=<dir> [BG_PICTURE=<16:9 jpg of a person>] … — also saves the processed frames per mode.
 */
const LK_URL = process.env['MOCK_LIVEKIT_URL'] ?? 'ws://127.0.0.1:7880';
const LK_KEY = process.env['MOCK_LIVEKIT_KEY'] ?? 'devkey';
const LK_SECRET = process.env['MOCK_LIVEKIT_SECRET'] ?? 'secret';
const PREFIX = process.env['MOCK_LIVEKIT_ROOM_PREFIX'] ?? 'mock_';
const LOOK_DIR = process.env['BG_LOOK_DIR'] ?? '';
const PICTURE = process.env['BG_PICTURE'] ?? '';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ARGS = ['--mute-audio', '--use-angle=metal', '--enable-gpu', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.webp': 'image/webp', '.tflite': 'application/octet-stream', '.json': 'application/json' };

let out = '';
let server: Server;
let origin = '';

test.beforeAll(async () => {
  test.setTimeout(180_000);
  out = mkdtempSync(join(tmpdir(), 'calaba-bg-'));
  await build({
    root: HERE,
    base: './',
    logLevel: 'warn',
    configFile: false,
    worker: { format: 'es' },
    build: { outDir: out, emptyOutDir: true, minify: false, target: 'es2022', rollupOptions: { input: join(HERE, 'bg.html') } },
  });
  server = createServer((req, res) => {
    const path = normalize(join(out, decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')));
    if (!path.startsWith(out) || !existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

test.afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(out, { recursive: true, force: true });
});

async function token(identity: string, room: string, publish: boolean): Promise<string> {
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity, ttl: '10m' });
  at.addGrant({ roomJoin: true, room, canPublish: publish, canSubscribe: !publish });
  return at.toJwt();
}

interface Look {
  lum: number;
  edges: number;
  frames: number;
  width: number;
}

type Bg = {
  start: (kind: string, imageId: string | null, picture: string | null) => Promise<void>;
  publish: (url: string, token: string) => Promise<void>;
  setMode: (kind: string, imageId: string | null) => Promise<void>;
  look: () => Promise<string>;
  status: () => { state: string; software: boolean };
  stats: () => { frames: number; segs: number; msPerFrame: number; seconds: number } | null;
  stop: () => Promise<void>;
};

/** The viewer: livekit-client from the same build is not exposed, so the UMD one. */
async function subscribe(page: Page, tok: string): Promise<void> {
  const umd = join(HERE, '../../../node_modules/livekit-client/dist/livekit-client.umd.js');
  await page.addScriptTag({ path: umd });
  await page.evaluate(
    async ({ url, tok }) => {
      const LK = (window as unknown as { LivekitClient: typeof import('livekit-client') }).LivekitClient;
      const room = new LK.Room({ adaptiveStream: false });
      await room.connect(url, tok, { autoSubscribe: false });
      const deadline = Date.now() + 15_000;
      let pub: import('livekit-client').RemoteTrackPublication | undefined;
      while (!pub && Date.now() < deadline) {
        for (const p of room.remoteParticipants.values()) pub ??= p.getTrackPublication(LK.Track.Source.Camera);
        if (!pub) await new Promise((r) => setTimeout(r, 200));
      }
      if (!pub) throw new Error('no camera in the room');
      pub.setSubscribed(true);
      while (!pub.track && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      const track = pub.track as import('livekit-client').RemoteVideoTrack | undefined;
      if (!track) throw new Error('not subscribed');
      const video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      document.body.appendChild(video);
      track.attach(video);
      await video.play().catch(() => undefined);
      (window as unknown as { __v: HTMLVideoElement; __t: typeof track }).__v = video;
      (window as unknown as { __t: typeof track }).__t = track;
    },
    { url: LK_URL, tok },
  );
}

/** Average luminance of the received picture (160×90), edge energy of its clock text, frames decoded so far. */
function measure(page: Page): Promise<Look> {
  return page.evaluate(async () => {
    const w = window as unknown as { __v: HTMLVideoElement; __t: import('livekit-client').RemoteVideoTrack };
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 90;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('no 2d');
    g.drawImage(w.__v, 0, 0, 160, 90);
    const d = g.getImageData(0, 0, 160, 90).data;
    const L = (i: number): number => 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
    let lum = 0;
    let edges = 0;
    for (let y = 0; y < 90; y++) {
      for (let x = 0; x < 160; x++) {
        const i = (y * 160 + x) * 4;
        lum += L(i);
        // Edge energy of the fake camera's clock text (top left): pure background detail.
        if (x >= 10 && x < 44 && y >= 2 && y < 10) edges += Math.abs(L(i) - L(i + 4)) + Math.abs(L(i) - L(i + 640));
      }
    }
    let frames = 0;
    (await w.__t.receiver?.getStats())?.forEach((s: Record<string, unknown>) => {
      if (s['type'] === 'inbound-rtp') frames = (s['framesDecoded'] as number | undefined) ?? 0;
    });
    return { lum: lum / (160 * 90), edges: edges / (34 * 8), frames, width: w.__v.videoWidth };
  });
}

async function save(pub: Page, name: string): Promise<void> {
  if (!LOOK_DIR) return;
  const url = await pub.evaluate(() => (window as unknown as { __bg: Bg }).__bg.look());
  writeFileSync(join(LOOK_DIR, `${name}.jpg`), Buffer.from(url.replace(/^data:image\/jpeg;base64,/, ''), 'base64'));
}

test('background: the processed camera is published and received (none → blur → picture)', async () => {
  test.setTimeout(150_000);
  const room = `${PREFIX}bg_${Date.now().toString(36)}`;
  const svc = new RoomServiceClient(LK_URL.replace(/^ws/, 'http'), LK_KEY, LK_SECRET);
  await svc.createRoom({ name: room, emptyTimeout: 60 });
  const browsers: Browser[] = [];
  try {
    const pb = await chromium.launch({ args: ARGS });
    browsers.push(pb);
    const pub = await pb.newPage();
    pub.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[publisher] ${m.text().slice(0, 300)}`);
    });
    await pub.goto(`${origin}bg.html`);
    await pub.waitForFunction(() => '__bg' in window);
    const picture = PICTURE ? `data:image/jpeg;base64,${readFileSync(PICTURE).toString('base64')}` : null;
    await pub.evaluate(([p]) => (window as unknown as { __bg: Bg }).__bg.start('none', null, p ?? null), [picture] as const);
    await pub.evaluate(([u, t]) => (window as unknown as { __bg: Bg }).__bg.publish(u, t), [LK_URL, await token('pub', room, true)] as const);

    const vb = await chromium.launch({ args: ARGS });
    browsers.push(vb);
    const view = await vb.newPage();
    await view.goto(`${origin}bg.html`);
    await subscribe(view, await token('viewer', room, false));
    await view.waitForTimeout(3000);
    const none = await measure(view);
    await save(pub, 'none');

    await pub.evaluate(() => (window as unknown as { __bg: Bg }).__bg.setMode('blur-strong', null));
    await expect.poll(() => pub.evaluate(() => (window as unknown as { __bg: Bg }).__bg.status().state), { timeout: 30_000 }).toBe('ready');
    const status = await pub.evaluate(() => (window as unknown as { __bg: Bg }).__bg.status());
    // The effect reaches the viewer within a few frames; on a busy machine give it time.
    const settle = async (ok: (l: Look) => boolean): Promise<Look> => {
      let last = await measure(view);
      const until = Date.now() + 20_000;
      while (!(PICTURE || ok(last)) && Date.now() < until) {
        await view.waitForTimeout(500);
        last = await measure(view);
      }
      if (PICTURE) await view.waitForTimeout(2500);
      return PICTURE ? measure(view) : last;
    };
    const blur = await settle((l) => l.edges < none.edges * 0.6);
    await save(pub, 'blur-strong');

    await pub.evaluate(() => (window as unknown as { __bg: Bg }).__bg.setMode('blur-light', null));
    await view.waitForTimeout(2000);
    await save(pub, 'blur-light');

    await pub.evaluate(() => (window as unknown as { __bg: Bg }).__bg.setMode('image', 'bg-03'));
    const image = await settle((l) => l.lum < Math.min(none.lum * 0.6, 70));
    await save(pub, 'image-bg-03');
    await view.waitForTimeout(3000);
    const work = await pub.evaluate(() => (window as unknown as { __bg: Bg }).__bg.stats());
    console.log(`[background] worker ${JSON.stringify(work)}`);

    console.log(`[background] software=${status.software} none ${JSON.stringify(none)} blur ${JSON.stringify(blur)} image ${JSON.stringify(image)}`);
    // Received and decoded all along.
    expect(none.width).toBeGreaterThan(0);
    expect(image.frames).toBeGreaterThan(blur.frames);
    expect(blur.frames).toBeGreaterThan(none.frames);
    if (!PICTURE) {
      // No person in the fake camera: all of it is background.
      expect(blur.edges, 'strong blur flattens the detail').toBeLessThan(none.edges * 0.6);
      // bg-03 «Графит» is dark; the fake camera's picture is not.
      expect(image.lum, 'the picture replaces the background').toBeLessThan(Math.min(none.lum * 0.6, 70));
    }
    await pub.evaluate(() => (window as unknown as { __bg: Bg }).__bg.stop());
  } finally {
    for (const b of browsers) await b.close();
    await svc.deleteRoom(room).catch(() => undefined);
  }
});

type Fx = { touchUp: boolean; touchUpStrength: number; lowLight: boolean };
type FxStats = { frames: number; rendered: number; segs: number; msPerFrame: number; seconds: number; mean: number; gamma: number };
type BgFx = Omit<Bg, 'start' | 'stats'> & {
  start: (kind: string, imageId: string | null, picture: string | null, effects: Fx | null) => Promise<void>;
  setEffects: (fx: Fx) => void;
  stats: () => FxStats | null;
};

/** The worker's next 5 s report (a fresh one, not the last before a change). */
async function nextStats(p: Page): Promise<FxStats | null> {
  const get = (): Promise<FxStats | null> => p.evaluate(() => (window as unknown as { __bg: BgFx }).__bg.stats());
  const first = JSON.stringify(await get());
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    await p.waitForTimeout(500);
    const s = await get();
    if (s && JSON.stringify(s) !== first) return s;
  }
  return null;
}

/**
 * Appearance effects (ADR-0035 addendum) on the wire, background «Нет»: a synthetic dark room is
 * published through the processor with no effect (frames pass through), then «Низкая
 * освещённость» must raise the received picture's mean luminance, and «Улучшить внешность» on top
 * keeps the frames coming. Chromium's fake camera (a bright frame) with low light on must stay
 * pass-through: a bright room is never touched.
 *
 *   pnpm -F @calaba/desktop e2e:media -g effects
 */
test('effects: low light lifts a dark room, touch-up keeps frames flowing, a bright room passes through', async () => {
  test.setTimeout(150_000);
  const room = `${PREFIX}fx_${Date.now().toString(36)}`;
  const svc = new RoomServiceClient(LK_URL.replace(/^ws/, 'http'), LK_KEY, LK_SECRET);
  await svc.createRoom({ name: room, emptyTimeout: 60 });
  const off: Fx = { touchUp: false, touchUpStrength: 40, lowLight: false };
  const browsers: Browser[] = [];
  try {
    const pb = await chromium.launch({ args: ARGS });
    browsers.push(pb);
    const pub = await pb.newPage();
    pub.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[publisher] ${m.text().slice(0, 300)}`);
    });
    await pub.goto(`${origin}bg.html`);
    await pub.waitForFunction(() => '__bg' in window);
    await pub.evaluate(([f]) => (window as unknown as { __bg: BgFx }).__bg.start('none', null, 'dark', f), [off] as const);
    await pub.evaluate(([u, t]) => (window as unknown as { __bg: BgFx }).__bg.publish(u, t), [LK_URL, await token('pub', room, true)] as const);

    const vb = await chromium.launch({ args: ARGS });
    browsers.push(vb);
    const view = await vb.newPage();
    await view.goto(`${origin}bg.html`);
    await subscribe(view, await token('viewer', room, false));
    await view.waitForTimeout(3000);
    const dark = await measure(view);

    await pub.evaluate(([f]) => (window as unknown as { __bg: BgFx }).__bg.setEffects(f), [{ ...off, lowLight: true }] as const);
    let lifted = await measure(view);
    const until = Date.now() + 20_000;
    while (lifted.lum < dark.lum * 1.5 && Date.now() < until) {
      await view.waitForTimeout(500);
      lifted = await measure(view);
    }
    await save(pub, 'lowlight');
    const liftStats = await nextStats(pub);

    await pub.evaluate(([f]) => (window as unknown as { __bg: BgFx }).__bg.setEffects(f), [{ ...off, lowLight: true, touchUp: true, touchUpStrength: 100 }] as const);
    await view.waitForTimeout(3000);
    const both = await measure(view);
    await save(pub, 'lowlight-touchup');
    const bothStats = await nextStats(pub);
    console.log(`[effects] dark ${JSON.stringify(dark)} lifted ${JSON.stringify(lifted)} both ${JSON.stringify(both)}`);
    console.log(`[effects] worker lift ${JSON.stringify(liftStats)} both ${JSON.stringify(bothStats)}`);
    await pub.evaluate(() => (window as unknown as { __bg: BgFx }).__bg.stop());

    expect(dark.width).toBeGreaterThan(0);
    expect(lifted.lum, 'low light raises the mean luminance of a dark room').toBeGreaterThan(dark.lum * 1.5);
    expect(liftStats?.gamma ?? 1, 'the curve is on').toBeLessThan(1);
    expect(both.frames, 'frames keep coming with both effects').toBeGreaterThan(lifted.frames);
    expect(bothStats?.rendered ?? 0).toBeGreaterThan(0);

    // A bright room (Chromium's fake camera): low light on, nothing rendered, the curve stays 1.
    const bright = await pb.newPage();
    await bright.goto(`${origin}bg.html`);
    await bright.waitForFunction(() => '__bg' in window);
    await bright.evaluate(([f]) => (window as unknown as { __bg: BgFx }).__bg.start('none', null, null, f), [{ ...off, lowLight: true }] as const);
    await bright.evaluate(() => (window as unknown as { __bg: BgFx }).__bg.look());
    const brightStats = await nextStats(bright);
    console.log(`[effects] bright ${JSON.stringify(brightStats)}`);
    expect(brightStats?.frames ?? 0).toBeGreaterThan(0);
    expect(brightStats?.mean ?? 0, 'the fake camera is a bright room').toBeGreaterThanOrEqual(0.25);
    expect(brightStats?.gamma, 'a bright room is never lifted').toBe(1);
    expect(brightStats?.rendered, 'and passes through without GL').toBe(0);
    await bright.evaluate(() => (window as unknown as { __bg: BgFx }).__bg.stop());

    // BG_LOOK_DIR + BG_PICTURE (a person): touch-up off / default / strongest, for eyes.
    if (LOOK_DIR && PICTURE) {
      const face = await pb.newPage();
      await face.goto(`${origin}bg.html`);
      await face.waitForFunction(() => '__bg' in window);
      const picture = `data:image/jpeg;base64,${readFileSync(PICTURE).toString('base64')}`;
      await face.evaluate(([p, f]) => (window as unknown as { __bg: BgFx }).__bg.start('none', null, p, f), [picture, off] as const);
      for (const [name, s] of [['touchup-off', 0], ['touchup-40', 40], ['touchup-100', 100]] as const) {
        await face.evaluate(([f]) => (window as unknown as { __bg: BgFx }).__bg.setEffects(f), [{ ...off, touchUp: s > 0, touchUpStrength: s }] as const);
        await face.waitForTimeout(500);
        await save(face, name);
      }
    }
  } finally {
    for (const b of browsers) await b.close();
    await svc.deleteRoom(room).catch(() => undefined);
  }
});
