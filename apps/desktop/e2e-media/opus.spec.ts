import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

/**
 * Voice tiers on the wire (docs/02 «Битрейт», lib/media/opusTier.ts) against the dev LiveKit
 * (`pnpm infra:dev`): a synthetic white-noise «microphone» is published at each tier; the
 * publisher's outgoing bitrate and the listener's received spectrum must follow the tier
 * (8 → telephone band, 16 → wideband, 32 → super-wideband, 64 → fullband). `legacy` publishes
 * the way the app did before the tiers (maxBitrate only) — the diagnosis of 28.09, logged only.
 *
 *   pnpm -F @calaba/desktop e2e:media -g opus      (MOCK_LIVEKIT_URL / _KEY / _SECRET, MOCK_LIVEKIT_ROOM_PREFIX)
 */
const LK_URL = process.env['MOCK_LIVEKIT_URL'] ?? 'ws://127.0.0.1:7880';
const LK_KEY = process.env['MOCK_LIVEKIT_KEY'] ?? 'devkey';
const LK_SECRET = process.env['MOCK_LIVEKIT_SECRET'] ?? 'secret';
const PREFIX = process.env['MOCK_LIVEKIT_ROOM_PREFIX'] ?? 'mock_';
const ARGS = ['--mute-audio', '--autoplay-policy=no-user-gesture-required'];

type Bands = Record<string, number>;
interface PubStats {
  bytesSent: number;
  ts: number;
  targetBitrate: number | null;
  answerFmtp: string | null;
}
interface Api {
  publish: (u: string, t: string, kbps: number, tiered: boolean) => Promise<void>;
  setTier: (kbps: number) => Promise<void>;
  pubStats: () => Promise<PubStats>;
  listen: (u: string, t: string) => Promise<void>;
  spectrum: (ms: number) => Promise<Bands>;
  stop: () => Promise<void>;
}
const api = (p: Page) => ({
  call: <K extends keyof Api>(k: K, ...a: Parameters<Api[K]>): Promise<Awaited<ReturnType<Api[K]>>> =>
    p.evaluate(([k, a]) => ((window as unknown as { __opus: Record<string, (...x: unknown[]) => unknown> }).__opus[k as string]?.(...(a as unknown[])) as Promise<never>), [k, a] as const),
});

async function bundle(): Promise<string> {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('./opusPage.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    define: { 'import.meta.env': '{}' },
    logLevel: 'silent',
  });
  return out.outputFiles[0]?.text ?? '';
}

async function token(identity: string, room: string): Promise<string> {
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity, ttl: '10m' });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  return at.toJwt();
}

let server: Server;
let origin = '';
let js = '';
let browser: Browser;
test.beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>opus</title>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  js = await bundle();
  browser = await chromium.launch({ args: ARGS });
});
test.afterAll(async () => {
  await browser.close();
  await new Promise((r) => server.close(r));
});

/** Outgoing kbps over `ms`. */
async function rate(p: Page, ms: number): Promise<{ kbps: number; stats: PubStats }> {
  const a = await api(p).call('pubStats');
  await p.waitForTimeout(ms);
  const b = await api(p).call('pubStats');
  return { kbps: Math.round(((b.bytesSent - a.bytesSent) * 8) / (b.ts - a.ts)), stats: b };
}

/** Publisher + listener in one room; returns both pages. */
async function session(name: string, kbps: number, tiered: boolean): Promise<{ pub: Page; lis: Page; done: () => Promise<void> }> {
  const room = `${PREFIX}opus_${name}_${Date.now().toString(36)}`;
  const svc = new RoomServiceClient(LK_URL.replace(/^ws/, 'http'), LK_KEY, LK_SECRET);
  await svc.createRoom({ name: room, emptyTimeout: 60 });
  const ctx = await browser.newContext();
  const pub = await ctx.newPage();
  const lis = await ctx.newPage();
  for (const [n, p] of [['pub', pub], ['lis', lis]] as const) {
    p.on('console', (m) => m.type() === 'error' && console.log(`[${n}] ${m.text().slice(0, 200)}`));
    await p.goto(origin);
    await p.addScriptTag({ content: js });
  }
  await api(pub).call('publish', LK_URL, await token('pub', room), kbps, tiered);
  await api(lis).call('listen', LK_URL, await token('lis', room));
  return {
    pub,
    lis,
    done: async () => {
      await api(pub).call('stop').catch(() => undefined);
      await ctx.close();
      await svc.deleteRoom(room).catch(() => undefined);
    },
  };
}

const line = (tag: string, kbps: number, r: { kbps: number; stats: PubStats }, s: Bands): string =>
  `${tag} ${String(kbps).padStart(2)}: out ${String(r.kbps).padStart(3)} kbps (target ${r.stats.targetBitrate ?? '?'}) · rx ${Object.entries(s).map(([k, v]) => `${k} ${v}`).join(' | ')} · fmtp ${r.stats.answerFmtp ?? '?'}`;

/** The spectrum edge a tier must show: [band that must carry signal, band that must be ≥ 25 dB below it]. */
const EDGE: Record<number, [string, string | null]> = {
  8: ['0.3-3.4k', '4-7k'],
  16: ['4-7k', '8.5-11k'],
  32: ['8.5-11k', '13-19k'],
  64: ['13-19k', null],
};

function expectEdge(kbps: number, s: Bands): void {
  const [on, off] = EDGE[kbps] ?? ['0.3-3.4k', null];
  const ref = s['0.3-3.4k'] ?? -200;
  expect.soft(s[on] ?? -200, `${kbps}: ${on} carries the signal`).toBeGreaterThan(ref - 15);
  if (off) expect.soft(s[off] ?? 0, `${kbps}: ${off} is cut`).toBeLessThan(ref - 25);
}

test('opus tiers: bitrate and bandwidth follow the tier', async () => {
  test.setTimeout(240_000);
  for (const tiered of [false, true]) {
    for (const kbps of [8, 16, 32, 64]) {
      const s = await session(`${tiered ? 't' : 'l'}${kbps}`, kbps, tiered);
      try {
        await s.pub.waitForTimeout(3000);
        const [r, sp] = await Promise.all([rate(s.pub, 5000), api(s.lis).call('spectrum', 5000)]);
        console.log(line(tiered ? 'tier  ' : 'legacy', kbps, r, sp));
        if (tiered) {
          expect.soft(r.kbps, `${kbps}: outgoing bitrate`).toBeLessThan(kbps * 1.35 + 4);
          expect.soft(r.kbps, `${kbps}: outgoing bitrate`).toBeGreaterThan(kbps * 0.6);
          expectEdge(kbps, sp);
        }
      } finally {
        await s.done();
      }
    }
  }
});

test('opus tiers: a room change applies live, without a republish', async () => {
  test.setTimeout(120_000);
  const s = await session('live', 64, true);
  try {
    await s.pub.waitForTimeout(3000);
    for (const kbps of [64, 8, 32]) {
      if (kbps !== 64) {
        await api(s.pub).call('setTier', kbps);
        await s.pub.waitForTimeout(2000);
      }
      const [r, sp] = await Promise.all([rate(s.pub, 4000), api(s.lis).call('spectrum', 4000)]);
      console.log(line('live  ', kbps, r, sp));
      expect.soft(r.kbps, `live ${kbps}: outgoing bitrate`).toBeLessThan(kbps * 1.35 + 4);
      expect.soft(r.kbps, `live ${kbps}: outgoing bitrate`).toBeGreaterThan(kbps * 0.6);
      expectEdge(kbps, sp);
    }
  } finally {
    await s.done();
  }
});
