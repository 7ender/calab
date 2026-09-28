/**
 * In-call re-render profiler (docs/14-energy.md «Ререндеры в звонке», docs/09 #60). Launches the
 * built renderer (apps/desktop/out) against the mock API + the dev LiveKit (`pnpm infra:dev`),
 * joins «Созвон» with a silent fake mic, opens «общий» (30 messages) with the members column,
 * 5 members online, 2 in voice, and replays live events like production for `--seconds`:
 * presence change every 5 s, typing every 4 s, a voice state change every 10 s, and with
 * `--speaker` a second LiveKit participant whose fake mic beeps every second (speaking rings);
 * the call timer, the echo/level tick, the mic level reports and getStats run for real.
 *
 * Prints JSON: commits/s, React render ms/s (selfBaseDuration), top components by time and by
 * count, what woke each one (parent / props / hook index / context) and which components
 * started the commits. `--bench C|E` then keeps the scenario running and samples CPU with
 * tools/energy-bench.py (E adds a remote 720p camera publisher).
 *
 *   CALABA_RENDERER_MINIFY=0 CALABA_REACT_PROFILING=1 pnpm -F @calaba/desktop build:app
 *   npx tsx tools/perf-call.ts [--port 39461] [--seconds 30] [--speaker] [--cpu] [--timeline] [--no-stats] [--no-emulate]
 *   npx tsx tools/perf-call.ts --seconds 0 --bench C --bench-seconds 90 --name after   # CPU of all app processes
 *
 * Heavy for the machine: run it under `nice -n 19`, one run at a time.
 *
 * One test Electron at a time (CLAUDE.md «Визуальные тесты»): check `pgrep -fl "playwright|out/main"` first.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium, _electron as electron, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { AccessToken } from 'livekit-server-sdk';
import { PresenceStatus } from '../packages/protocol/src/gen/calaba/v1/gateway_pb';
import { IDS } from '../apps/desktop/e2e-support/fixtures';
import { livekitRoomPrefix, startMockServer } from '../apps/desktop/e2e-support/mock-server';
import { startPublisher, type Publisher } from '../apps/desktop/e2e-visual/publisher';

const argv = process.argv;
const opt = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 ? (argv[i + 1] ?? def) : def;
};
const PORT = Number(opt('port', '39461'));
const SECONDS = Number(opt('seconds', '30'));
const BENCH = opt('bench', '');
const BENCH_SECONDS = Number(opt('bench-seconds', '120'));
const NAME = opt('name', 'run');
const STATS = !argv.includes('--no-stats');
const EMULATE = !argv.includes('--no-emulate');
const CPU = argv.includes('--cpu');
const SPEAKER = argv.includes('--speaker');
const ROOT = resolve(import.meta.dirname, '..');
const DESKTOP = resolve(ROOT, 'apps/desktop');
process.env['MOCK_LIVEKIT_ROOM_PREFIX'] ||= `perfcall${PORT}_`;

/** Injected before the renderer: a React DevTools hook that attributes every commit. */
const INIT = () => {
  type F = {
    tag: number;
    flags: number;
    type: unknown;
    child: F | null;
    sibling: F | null;
    return: F | null;
    alternate: F | null;
    memoizedProps: Record<string, unknown> | null;
    memoizedState: H;
    dependencies: { firstContext: unknown } | null;
    selfBaseDuration?: number;
    actualDuration?: number;
  };
  type H = { memoizedState: unknown; next: H } | null;
  const st = {
    on: false,
    commits: 0,
    commitMs: 0,
    renders: {} as Record<string, number>,
    selfMs: {} as Record<string, number>,
    why: {} as Record<string, number>,
    origin: {} as Record<string, number>,
    sample: {} as Record<string, string>,
    mounts: {} as Record<string, number>,
    originCommits: {} as Record<string, number>,
    timeline: [] as string[],
  };
  (window as unknown as Record<string, unknown>)['__perf'] = st;
  const COMP = [0, 1, 11, 14, 15];
  const mark = new WeakMap<object, number>();
  let n = 0;
  const nameOf = (f: F): string | null => {
    const t = f.type as { displayName?: string; name?: string; render?: { name?: string; displayName?: string }; type?: { name?: string; displayName?: string } } | null;
    if (!t) return null;
    if (typeof t === 'function') return t.displayName || t.name || 'anon';
    if (typeof t === 'object') return t.displayName || (t.render ? t.render.displayName || t.render.name || 'anon' : t.type ? t.type.displayName || t.type.name || 'anon' : null);
    return null;
  };
  const brief = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return String(v).slice(0, 40);
    if (Array.isArray(v)) return `array(${v.length})`;
    return `{${Object.keys(v).slice(0, 4).join(',')}}`;
  };
  const renderedComp = (f: F | null): boolean => !!f && COMP.includes(f.tag) && (f.flags & 1) !== 0 && mark.get(f) === n;
  (window as unknown as Record<string, unknown>)['__REACT_DEVTOOLS_GLOBAL_HOOK__'] = {
    supportsFiber: true,
    renderers: new Map(),
    inject(r: unknown) {
      const m = this.renderers as Map<number, unknown>;
      m.set(m.size + 1, r);
      return m.size;
    },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: F }) {
      n++;
      // Pass 1: the fibers this commit touched. Like React DevTools (didFiberRender), a subtree
      // whose child list is the very one of the previous tree (`child === alternate.child`) was
      // not cloned: nothing in it rendered, and its fibers keep stale PerformedWork flags from
      // older renders, so it is not descended into. A cloned fiber that bailed out has its flags
      // reset; one that rendered (or mounted) carries PerformedWork (1).
      const done: F[] = [];
      const stack: F[] = [root.current];
      while (stack.length) {
        const f = stack.pop() as F;
        mark.set(f, n);
        if (COMP.includes(f.tag) && f.flags & 1) done.push(f);
        if (f.sibling && f !== root.current) stack.push(f.sibling);
        if (f.child && (!f.alternate || f.child !== f.alternate.child)) stack.push(f.child);
      }
      if (!st.on) return;
      st.commits++;
      st.commitMs += root.current.actualDuration ?? 0;
      const woke = new Set<string>();
      const wokeWhy = new Set<string>();
      for (const f of done) {
        const k = nameOf(f);
        if (!k) continue;
        st.renders[k] = (st.renders[k] ?? 0) + 1;
        st.selfMs[k] = (st.selfMs[k] ?? 0) + (f.selfBaseDuration ?? 0);
        let p = f.return;
        while (p && !COMP.includes(p.tag)) p = p.return;
        const parent = renderedComp(p);
        const alt = f.alternate;
        const why: string[] = [];
        if (!alt) {
          why.push('mount');
          // The top of a mounted subtree: its parent component already existed.
          if (p?.alternate) {
            const mk = `${nameOf(p)} > ${k}`;
            st.mounts[mk] = (st.mounts[mk] ?? 0) + 1;
          }
        }
        else {
          const cur = f.memoizedProps ?? {};
          const old = alt.memoizedProps ?? {};
          const changed = Object.keys(cur).filter((x) => cur[x] !== old[x]);
          if (changed.length) why.push(`props:${changed.slice(0, 5).join(',')}`);
          let h1 = f.memoizedState;
          let h2 = alt.memoizedState;
          if (f.tag !== 1) {
            for (let i = 0; h1 && h2 && i < 60; i++, h1 = h1.next, h2 = h2.next) {
              const v = h1.memoizedState;
              if (v === h2.memoizedState) continue;
              // Effects get a new object every render and memo/callback [value, deps] follow
              // their deps: neither is a cause. State / store snapshots are.
              if (v && typeof v === 'object' && 'create' in v && 'deps' in v) continue;
              if (Array.isArray(v) && v.length === 2 && (Array.isArray(v[1]) || v[1] === null)) continue;
              why.push(`hook${i}`);
              const sk = `${k}:hook${i}`;
              const o = h2.memoizedState;
              const diff =
                v && o && typeof v === 'object' && typeof o === 'object' && !Array.isArray(v)
                  ? ` Δ${Object.keys(v).filter((x) => (v as Record<string, unknown>)[x] !== (o as Record<string, unknown>)[x]).join('+')}`
                  : ` was ${brief(o)}`;
              st.sample[sk] = brief(v) + diff;
            }
          }
          if (!why.length) why.push(parent ? 'parent(same props)' : 'context/force');
        }
        const wk = `${k} ← ${why.join('|')}`;
        st.why[wk] = (st.why[wk] ?? 0) + 1;
        // Where the update started: a rendered component whose parent component didn't render.
        if (!parent && alt) {
          st.origin[k] = (st.origin[k] ?? 0) + 1;
          woke.add(k);
          wokeWhy.add(`${k}:${why.join('|')}`);
        }
      }
      for (const k of woke) st.originCommits[k] = (st.originCommits[k] ?? 0) + 1;
      if (st.timeline.length < 400) st.timeline.push(`${Math.round(performance.now())} ${done.length} ${[...wokeWhy].slice(0, 8).join(' ; ')}`);
    },
  };
};

interface Perf {
  on: boolean;
  commits: number;
  commitMs: number;
  renders: Record<string, number>;
  selfMs: Record<string, number>;
  why: Record<string, number>;
  origin: Record<string, number>;
  sample: Record<string, string>;
  mounts: Record<string, number>;
  originCommits: Record<string, number>;
  timeline: string[];
}

/** 10 s of −70 dBFS white noise, 48 kHz mono 16-bit (Chromium loops the fake capture file). */
function silentWav(path: string): void {
  const rate = 48_000;
  const samples = rate * 10;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  const amp = 32767 * 10 ** (-70 / 20) * Math.sqrt(3);
  let seed = 1;
  for (let i = 0; i < samples; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    b.writeInt16LE(Math.round(((seed / 0x7fffffff) * 2 - 1) * amp), 44 + i * 2);
  }
  writeFileSync(path, b);
}

/** A second participant publishing Chromium's fake microphone (a beep every second). */
async function startSpeaker(userId: string, name: string, roomId: string): Promise<Browser> {
  const at = new AccessToken(process.env['MOCK_LIVEKIT_KEY'] ?? 'devkey', process.env['MOCK_LIVEKIT_SECRET'] ?? 'secret', { identity: `${userId}:speaker`, name, ttl: '10m' });
  at.addGrant({ roomJoin: true, room: `${livekitRoomPrefix()}${roomId}`, canPublish: true, canSubscribe: false });
  const token = await at.toJwt();
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
  const page = await browser.newPage();
  const umd = createRequire(import.meta.url).resolve('livekit-client');
  await page.addScriptTag({ path: umd.replace(/[^/]+$/, 'livekit-client.umd.js') });
  await page.evaluate(
    async ({ url, token }) => {
      const LK = (window as unknown as { LivekitClient: typeof import('livekit-client') }).LivekitClient;
      const room = new LK.Room();
      await room.connect(url, token);
      await room.localParticipant.setMicrophoneEnabled(true);
    },
    { url: process.env['MOCK_LIVEKIT_URL'] ?? 'ws://127.0.0.1:7880', token },
  );
  return browser;
}

async function launch(url: string, userData: string, wav: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.', '--lang=ru', '--mute-audio', `--use-file-for-fake-audio-capture=${wav}`, '--disable-features=AudioServiceOutOfProcess'],
    cwd: DESKTOP,
    env: { ...process.env, CALABA_SERVER_URL: url, CALABA_USER_DATA: userData, CALABA_MULTI_INSTANCE: '1', CALABA_FAKE_MEDIA: '1', ELECTRON_RENDERER_URL: '', LANG: 'ru_RU.UTF-8' },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.setContentSize(1280, 800);
    w?.setIgnoreMouseEvents(true);
  });
  return { app, page };
}

const round = (x: number, d = 1): number => Math.round(x * 10 ** d) / 10 ** d;

async function main(): Promise<void> {
  const mock = await startMockServer({ port: PORT, scenario: 'data', quiet: true } as never);
  const userData = mkdtempSync(join(tmpdir(), 'calaba-perfcall-'));
  const wav = join(userData, 'silence.wav');
  silentWav(wav);
  const timers: NodeJS.Timeout[] = [];
  let publisher: Publisher | null = null;
  let speaker: Browser | null = null;
  let app: ElectronApplication | null = null;
  try {
    // Sign in once, then relaunch with the hook installed from the first script.
    {
      const l = await launch(mock.url, userData, wav);
      const p = l.page;
      await p.evaluate((stats) => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru', devStats: stats }, version: 1 })), STATS);
      await p.reload();
      await p.getByLabel('Email').fill('owner@calaba.test');
      await p.getByLabel('Пароль').fill('password123');
      await p.getByRole('button', { name: 'Войти', exact: true }).click();
      await p.locator('aside').first().waitFor({ timeout: 30_000 });
      await p.waitForTimeout(1000);
      await l.app.close();
    }
    const l = await launch(mock.url, userData, wav);
    app = l.app;
    const page = l.page;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `var __name = (f) => f; (${INIT.toString()})()` });
    await page.reload();
    const aside = page.locator('aside').first();
    await aside.waitFor({ timeout: 30_000 });

    // The scene: Vera leaves «Переговорка», Борис is in «Созвон» (unmuted) with me; 5 online.
    mock.setVoiceState({ userId: IDS.users.vera, roomId: '' });
    mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.call, muted: false });
    for (const u of [IDS.users.boris, IDS.users.vera, IDS.users.grigory, IDS.users.dina]) mock.setPresence(u, PresenceStatus.ONLINE);
    for (let i = 0; i < 5; i++) mock.injectMessage({ roomId: IDS.rooms.general, authorId: i % 2 ? IDS.users.vera : IDS.users.boris, content: `perf call message ${i}` });
    await aside.getByRole('button', { name: /Созвон/ }).first().click();
    await page.getByText('Голос подключён').first().waitFor({ timeout: 30_000 });
    await aside.getByRole('button', { name: /общий/ }).first().click();
    await page.getByRole('heading', { name: 'общий' }).first().waitFor();
    await page.getByRole('button', { name: /^Качество связи/ }).first().waitFor({ timeout: 15_000 });
    const membersOpen = await page.getByRole('complementary').filter({ hasText: /В сети|Участники/ }).count();

    if (BENCH === 'E') {
      mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.call, muted: false, camera: true });
      publisher = await startPublisher({ userId: IDS.users.boris, name: 'Борис Петров', roomId: IDS.rooms.call, source: 'camera' });
    }

    // Live events, like production.
    if (EMULATE) {
      let k = 0;
      timers.push(setInterval(() => mock.setPresence(IDS.users.grigory, k++ % 2 ? PresenceStatus.ONLINE : PresenceStatus.IDLE), 5000));
      let m = 0;
      timers.push(setInterval(() => mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.call, muted: m++ % 2 === 0, ...(BENCH === 'E' ? { camera: true } : {}) }), 10_000));
      timers.push(setInterval(() => void fetch(`${mock.url}/__mock/typing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId: IDS.rooms.general, userId: IDS.users.vera }) }), 4000));
    }
    // A real remote speaker: Chromium's fake microphone beeps once a second, so LiveKit's active
    // speakers and the level-driven rings flip on and off like in a conversation.
    if (EMULATE && SPEAKER) speaker = await startSpeaker(IDS.users.boris, 'Борис Петров', IDS.rooms.call);
    await page.waitForTimeout(3000);

    const out: Record<string, unknown> = { membersOpen, stats: STATS, emulate: EMULATE, seconds: SECONDS };
    if (SECONDS > 0) {
      await cdp.send('Performance.enable');
      const metrics = async (): Promise<Record<string, number>> =>
        Object.fromEntries(((await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((x) => [x.name, x.value]));
      await page.evaluate(() => {
        const p = (window as unknown as { __perf: Perf }).__perf;
        Object.assign(p, { on: true, commits: 0, commitMs: 0, renders: {}, selfMs: {}, why: {}, origin: {}, sample: {}, mounts: {}, originCommits: {}, timeline: [] });
      });
      const m0 = await metrics();
      // --cpu: a sampling JS profile of the same window, summarised by self time per function.
      if (CPU) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
        await cdp.send('Profiler.start');
      }
      await page.waitForTimeout(SECONDS * 1000);
      const m1 = await metrics();
      if (CPU) {
        type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number };
        const { profile } = (await cdp.send('Profiler.stop')) as { profile: { nodes: Node[]; samples: number[]; timeDeltas: number[] } };
        const byId = new Map(profile.nodes.map((x) => [x.id, x]));
        const self = new Map<string, number>();
        profile.samples.forEach((id, i) => {
          const node = byId.get(id);
          if (!node) return;
          const f = node.callFrame;
          const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop() ?? ''}:${f.lineNumber + 1}`;
          self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
        });
        out['cpuSelfMsPerSec'] = [...self.entries()]
          .filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 30)
          .map(([k, v]) => [k, round(v / SECONDS, 2)]);
        out['cpuGcMsPerSec'] = round((self.get('(garbage collector) :0') ?? 0) / SECONDS, 2);
        out['cpuProgramMsPerSec'] = round((self.get('(program) :0') ?? 0) / SECONDS, 2);
      }
      const p = await page.evaluate(() => {
        const x = (window as unknown as { __perf: Perf }).__perf;
        x.on = false;
        return JSON.parse(JSON.stringify(x)) as Perf;
      });
      const d = (k: string): number => (m1[k] ?? 0) - (m0[k] ?? 0);
      // Running CSS animations / transitions at the end (each one restyles every frame).
      out['animations'] = await page.evaluate(() =>
        document.getAnimations().map((a) => {
          const el = (a.effect as KeyframeEffect | null)?.target as Element | null;
          return `${(a as CSSAnimation).animationName ?? a.constructor.name} ${el?.tagName.toLowerCase() ?? ''}.${String(el?.className ?? '').slice(0, 40)}`;
        }),
      );
      const skip = /^(Primitive|Popper|Tooltip|Menu|ContextMenu|DropdownMenu|Presence|Slot|Dismissable|Focus|Portal|Collection|Roving|Popover|Dialog|anon)/;
      const comps = Object.keys(p.renders).filter((c) => !skip.test(c));
      const totalMs = Object.values(p.selfMs).reduce((a, b) => a + b, 0);
      Object.assign(out, {
        commits: p.commits,
        commitsPerSec: round(p.commits / SECONDS, 2),
        reactMsPerSec: round(p.commitMs / SECONDS, 2),
        selfMsPerSec: round(totalMs / SECONDS, 2),
        rendersPerSec: round(Object.values(p.renders).reduce((a, b) => a + b, 0) / SECONDS, 1),
        scriptMsPerSec: round((d('ScriptDuration') * 1000) / SECONDS, 2),
        taskMsPerSec: round((d('TaskDuration') * 1000) / SECONDS, 2),
        layoutsPerSec: round(d('LayoutCount') / SECONDS, 2),
        styleRecalcsPerSec: round(d('RecalcStyleCount') / SECONDS, 2),
        topByTime: comps
          .sort((a, b) => (p.selfMs[b] ?? 0) - (p.selfMs[a] ?? 0))
          .slice(0, 15)
          .map((c) => [c, round(p.selfMs[c] ?? 0, 2), p.renders[c]]),
        topByCount: comps
          .sort((a, b) => (p.renders[b] ?? 0) - (p.renders[a] ?? 0))
          .slice(0, 15)
          .map((c) => [c, p.renders[c], round(p.selfMs[c] ?? 0, 2)]),
        origins: Object.entries(p.origin)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([k, v]) => [k, v, p.originCommits[k] ?? 0]),
        why: Object.entries(p.why)
          .filter(([k]) => !skip.test(k))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 40),
        mountRoots: Object.entries(p.mounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20),
        hookSamples: p.sample,
        ...(argv.includes('--timeline') ? { timeline: p.timeline } : {}),
      });
    }
    process.stdout.write(`{\n${Object.entries(out).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}\n`);

    if (BENCH) {
      const bundle = resolve(ROOT, 'node_modules/electron/dist/Electron.app');
      const outDir = opt('bench-out', join(tmpdir(), 'calaba-energy'));
      const r = spawnSync('python3', [join(ROOT, 'tools/energy-bench.py'), bundle, `calab-${NAME}`, BENCH === 'E' ? 'E-watch-video' : 'C-voice-quiet', '--seconds', String(BENCH_SECONDS), '--out', outDir], {
        stdio: 'inherit',
      });
      if (r.status !== 0) process.exitCode = 1;
    }
  } finally {
    for (const t of timers) clearInterval(t);
    await publisher?.stop().catch(() => undefined);
    await speaker?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await mock.close();
    rmSync(userData, { recursive: true, force: true });
  }
}

void main();
