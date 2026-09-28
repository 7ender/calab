import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { chromium, expect, firefox, test, webkit, type Browser, type BrowserType, type Page } from '@playwright/test';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import type { OutLayer } from './page';

/**
 * H.264 High on the wire (docs/02 «Кодек», lib/media/h264.ts) against the dev LiveKit (`pnpm
 * infra:dev`): the app's own `startScreenShare` publishes a 2560×1664 canvas «screen» from Chromium
 * at the 720p preset; the publisher's getStats must show the negotiated profile and even layers
 * (1104×720 + 552×360, not 1107×720 + 553×360). Viewers in Chromium, WebKit and Firefox (whichever
 * Playwright has installed) subscribe and must decode frames.
 *
 *   pnpm -F @calaba/desktop e2e:media        (MOCK_LIVEKIT_URL / _KEY / _SECRET, MOCK_LIVEKIT_ROOM_PREFIX)
 */
const LK_URL = process.env['MOCK_LIVEKIT_URL'] ?? 'ws://127.0.0.1:7880';
const LK_KEY = process.env['MOCK_LIVEKIT_KEY'] ?? 'devkey';
const LK_SECRET = process.env['MOCK_LIVEKIT_SECRET'] ?? 'secret';
const PREFIX = process.env['MOCK_LIVEKIT_ROOM_PREFIX'] ?? 'mock_';

const require = createRequire(import.meta.url);
const UMD = require.resolve('livekit-client').replace(/[^/]+$/, 'livekit-client.umd.js');

/** The page bundle: the renderer modules as the app ships them, minus platform / i18n / log. */
async function bundle(): Promise<string> {
  const stubs: Record<string, string> = {
    platform: 'export const platform = { kind: "web" };',
    i18n: 'export const t = (k) => k; export const getLocale = () => "ru"; export const numberFormat = () => new Intl.NumberFormat("ru");',
    log: 'export const log = { info: console.info, warn: console.warn, error: console.error, debug: console.debug };',
  };
  const stub: Plugin = {
    name: 'stub',
    setup(b) {
      b.onResolve({ filter: /\/(platform|i18n|log)$/ }, (a) => {
        const name = /\/(platform|i18n|log)$/.exec(a.path)?.[1] ?? '';
        return { path: name, namespace: 'stub' };
      });
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path] ?? '', loader: 'js' }));
    },
  };
  const out = await build({
    entryPoints: [fileURLToPath(new URL('./page.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    define: { 'import.meta.env': '{}' },
    plugins: [stub],
    logLevel: 'silent',
  });
  return out.outputFiles[0]?.text ?? '';
}

async function token(identity: string, room: string, publish: boolean): Promise<string> {
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity, ttl: '10m' });
  at.addGrant({ roomJoin: true, room, canPublish: publish, canSubscribe: !publish });
  return at.toJwt();
}

interface Received {
  mime: string | null;
  fmtp: string | null;
  decoder: string | null;
  framesDecoded: number;
  width: number | null;
  height: number | null;
}

/** A viewer on livekit-client's UMD build: subscribes to the screen share, returns inbound stats twice (3 s apart). */
async function watch(page: Page, url: string, tok: string): Promise<[Received, Received]> {
  await page.addScriptTag({ path: UMD });
  return page.evaluate(
    async ({ url, tok }) => {
      const LK = (window as unknown as { LivekitClient: typeof import('livekit-client') }).LivekitClient;
      const room = new LK.Room({ adaptiveStream: false });
      await room.connect(url, tok, { autoSubscribe: false });
      const deadline = Date.now() + 15_000;
      let pub: import('livekit-client').RemoteTrackPublication | undefined;
      while (!pub && Date.now() < deadline) {
        for (const p of room.remoteParticipants.values()) pub ??= p.getTrackPublication(LK.Track.Source.ScreenShare);
        if (!pub) await new Promise((r) => setTimeout(r, 200));
      }
      if (!pub) throw new Error('no screen share in the room');
      pub.setSubscribed(true);
      pub.setVideoQuality(LK.VideoQuality.HIGH);
      while (!pub.track && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      const track = pub.track as import('livekit-client').RemoteVideoTrack | undefined;
      if (!track) throw new Error('not subscribed');
      const video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      document.body.appendChild(video);
      track.attach(video);
      await video.play().catch(() => undefined);
      const sample = async () => {
        const report = await track.receiver?.getStats();
        let got: Received = { mime: null, fmtp: null, decoder: null, framesDecoded: 0, width: null, height: null };
        report?.forEach((s: Record<string, unknown>) => {
          if (s['type'] !== 'inbound-rtp' || s['kind'] !== 'video') return;
          const c = typeof s['codecId'] === 'string' ? (report.get(s['codecId']) as Record<string, unknown> | undefined) : undefined;
          got = {
            mime: (c?.['mimeType'] as string | undefined) ?? null,
            fmtp: (c?.['sdpFmtpLine'] as string | undefined) ?? null,
            decoder: (s['decoderImplementation'] as string | undefined) ?? null,
            framesDecoded: (s['framesDecoded'] as number | undefined) ?? 0,
            width: (s['frameWidth'] as number | undefined) ?? null,
            height: (s['frameHeight'] as number | undefined) ?? null,
          };
        });
        return got;
      };
      await new Promise((r) => setTimeout(r, 4000));
      const a = await sample();
      await new Promise((r) => setTimeout(r, 3000));
      const b = await sample();
      return [a, b] as [Received, Received];
    },
    { url, tok },
  );
}

/**
 * An empty page on http://127.0.0.1: a secure context in every engine, so Chromium's local network
 * access checks let it reach the loopback LiveKit (about:blank is blocked).
 */
let server: Server;
let origin = '';
test.beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>h264</title>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
test.afterAll(async () => {
  await new Promise((r) => server.close(r));
});

/** Viewers: Google Chrome (High in its codec list), Playwright's Chromium (no High receive codec), WebKit, Firefox. */
const VIEWERS: Array<[string, BrowserType, string?]> = [
  ['chrome', chromium, 'chrome'],
  ['chromium', chromium],
  ['webkit', webkit],
  ['firefox', firefox],
];

/** Fake camera / mic without prompts: an active capture makes Chrome expose `encoderImplementation`. */
const CHROME_ARGS = ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

async function launch(bt: BrowserType, channel?: string): Promise<Browser | null> {
  try {
    if (channel) return await bt.launch({ channel, args: CHROME_ARGS });
    if (bt === firefox) {
      // Firefox drops loopback candidates and hides host ones behind mDNS; the dev LiveKit is on 127.0.0.1.
      return await bt.launch({ firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.peerconnection.ice.loopback': true, 'media.peerconnection.ice.obfuscate_host_addresses': false, 'media.volume_scale': '0.0' } });
    }
    if (bt === webkit) return await bt.launch();
    return await bt.launch({ args: CHROME_ARGS });
  } catch (err) {
    console.log(`[browser] ${channel ?? bt.name()} did not start: ${String(err).split('\n')[0]?.slice(0, 200) ?? ''}`);
    return null; // not installed: reported as «not checked»
  }
}

for (const profile of ['high', 'cb'] as const) {
  test(`H.264 ${profile}: publish params and viewers decode`, async () => {
    test.setTimeout(120_000);
    const room = `${PREFIX}h264_${profile}_${Date.now().toString(36)}`;
    // The dev LiveKit does not auto-create rooms (like the mock server, e2e-support/mock-server.ts).
    const svc = new RoomServiceClient(LK_URL.replace(/^ws/, 'http'), LK_KEY, LK_SECRET);
    await svc.createRoom({ name: room, emptyTimeout: 60 });
    const js = await bundle();
    // The publisher: Google Chrome when installed (it encodes High; Playwright's Chromium build has
    // no High encoder, so «high» falls back to LiveKit's Constrained Baseline there).
    const chrome = await launch(chromium, 'chrome');
    const pubBrowser = chrome ?? (await chromium.launch({ args: CHROME_ARGS }));
    const highAvailable = chrome !== null;
    const viewers: Browser[] = [];
    try {
      const pub = await pubBrowser.newPage();
      pub.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') console.log(`[publisher] ${m.text().slice(0, 200)}`);
      });
      await pub.goto(origin);
      await pub.addScriptTag({ content: js });
      const res = await pub.evaluate(
        ([u, t, p]) => (window as unknown as { __h264: { publish: (u: string, t: string, p: string, w: number, h: number) => Promise<unknown> } }).__h264.publish(u, t, p, 1107, 720),
        [LK_URL, await token('pub', room, true), profile] as const,
      );
      console.log('captured', JSON.stringify(res));

      const results: string[] = [];
      for (const [name, bt, channel] of VIEWERS) {
        const b = await launch(bt, channel);
        if (!b) {
          results.push(`${name}: not installed`);
          continue;
        }
        viewers.push(b);
        const page = await b.newPage();
        await page.goto(origin);
        try {
          const [a, z] = await watch(page, LK_URL, await token(`viewer-${name}`, room, false));
          results.push(`${name}: ${z.mime} ${z.fmtp ?? ''} ${z.decoder ?? '?'} ${z.width}×${z.height} frames ${a.framesDecoded}→${z.framesDecoded}`);
          expect.soft(z.framesDecoded, `${name} decodes`).toBeGreaterThan(a.framesDecoded);
          expect.soft(z.mime?.toLowerCase(), `${name} gets H.264`).toBe('video/h264');
        } catch (err) {
          results.push(`${name}: failed — ${String(err).split('\n')[0]}`);
          expect.soft(String(err), `${name} watches`).toBe('');
        }
      }

      const layers = await pub.evaluate(() => (window as unknown as { __h264: { stats: () => Promise<OutLayer[]> } }).__h264.stats());
      for (const l of layers) console.log(`[publisher] ${l.rid ?? '-'} ${l.mime} ${l.fmtp} ${l.encoder} pe=${l.powerEfficient} ${l.width}×${l.height} frames ${l.framesEncoded}`);
      for (const r of results) console.log(`[viewer] ${r}`);

      const active = layers.filter((l) => l.framesEncoded > 0);
      expect(active.length).toBeGreaterThan(0);
      for (const l of active) {
        expect(l.mime?.toLowerCase()).toBe('video/h264');
        expect(l.fmtp ?? '').toMatch(profile === 'high' && highAvailable ? /profile-level-id=64/ : /profile-level-id=42e0/);
        expect((l.width ?? 1) % 2, `layer ${l.rid} width ${l.width} even`).toBe(0);
        expect((l.height ?? 1) % 2, `layer ${l.rid} height ${l.height} even`).toBe(0);
      }
      // A 2560×1664 screen at the 720p preset is 1107×720: aligned down to 1104×720, thumb exactly half.
      expect(active.map((l) => `${l.width}×${l.height}`).sort()).toEqual(['1104×720', '552×360']);
      await pub.evaluate(() => (window as unknown as { __h264: { stop: () => Promise<void> } }).__h264.stop());
    } finally {
      for (const b of viewers) await b.close();
      await pubBrowser.close();
      await svc.deleteRoom(room).catch(() => undefined);
    }
  });
}
