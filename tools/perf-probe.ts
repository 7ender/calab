/**
 * Client performance probe (docs/18-optimization-audit.md). Read-only: launches the production
 * renderer (apps/desktop/out) against the deterministic mock API on its own port and a temp
 * userData, prints JSON with startup timings, React re-render counts per component, observer /
 * timer inventory, heap after room switching and duplicate REST requests. No side effects.
 *
 *   CALABA_RENDERER_MINIFY=0 pnpm -F @calaba/desktop build:app   # out/ must be fresh; unminified
 *                                          # keeps our component names in the render counts
 *   npx tsx tools/perf-probe.ts [--port 39377] [--launches 3]
 *
 * One test Electron at a time (CLAUDE.md «Визуальные тесты»): don't run in parallel with e2e.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { IDS } from '../apps/desktop/e2e-support/fixtures';
import { startMockServer, type MockServer } from '../apps/desktop/e2e-support/mock-server';

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const PORT = arg('port', 39377);
const LAUNCHES = arg('launches', 3);
const DESKTOP = resolve(import.meta.dirname, '../apps/desktop');

/** Injected before the renderer: a minimal React DevTools hook + observer/timer/blob counters. */
const INIT = () => {
  const w = window as unknown as Record<string, unknown>;
  const st = {
    on: false,
    commits: 0,
    renders: {} as Record<string, number>,
    roots: {} as Record<string, number>,
    observers: { ResizeObserver: 0, IntersectionObserver: 0, MutationObserver: 0 } as Record<string, number>,
    observed: { ResizeObserver: 0, IntersectionObserver: 0, MutationObserver: 0 } as Record<string, number>,
    intervals: new Map<number, number>(),
    timeouts: 0,
    blobs: { created: 0, revoked: 0 },
    t0: performance.now(),
  };
  w['__perf'] = st;
  // React DevTools hook: counts function/class/memo/forwardRef fibers that did work per commit.
  // A fiber object kept from the previous commit wasn't re-rendered (nor its subtree): pruned.
  const mark = new WeakMap<object, number>();
  type F = { tag: number; flags: number; type: unknown; child: F | null; sibling: F | null };
  const nameOf = (f: F): string | null => {
    const t = f.type as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string; displayName?: string } } | null;
    if (!t) return null;
    if (typeof t === 'function') return t.displayName || t.name || 'anon';
    if (typeof t === 'object') return t.displayName || (t.render ? `${t.render.name || 'anon'}` : t.type ? `${t.type.displayName || t.type.name || 'anon'}` : null);
    return null;
  };
  w['__REACT_DEVTOOLS_GLOBAL_HOOK__'] = {
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
      const n = ++st.commits;
      // Like React DevTools (didFiberRender): a child list that is the very one of the previous
      // tree (`child === alternate.child`) was not cloned — nothing under it rendered, and its
      // fibers keep stale PerformedWork flags from older renders, so it is not descended into
      // (the old «object seen in the previous commit» test descended into such subtrees and
      // counted phantom renders, docs/14 «Ререндеры в звонке»).
      const stack: F[] = [root.current];
      while (stack.length) {
        const f = stack.pop() as F & { alternate: F | null };
        mark.set(f, n);
        if (st.on && [0, 1, 11, 14, 15].includes(f.tag) && f.flags & 1) {
          const k = nameOf(f);
          if (k) st.renders[k] = (st.renders[k] ?? 0) + 1;
          // Render roots: the top-most ancestor that also rendered in this commit (who caused it).
          if (k === 'Bubble' || k === 'Feed' || k === 'Sidebar') {
            let top: F = f;
            for (let a = (f as F & { return: F | null }).return; a; a = (a as F & { return: F | null }).return) {
              if ([0, 1, 11, 14, 15].includes(a.tag) && a.flags & 1 && mark.get(a) === n) top = a;
            }
            const key = `${k}<-${nameOf(top)}`;
            st.roots[key] = (st.roots[key] ?? 0) + 1;
            // Why: props changed (parent rendered) or which hook's state changed.
            type H = { memoizedState: unknown; next: H | null } | null;
            const alt = (f as F & { alternate: (F & { memoizedProps: Record<string, unknown>; memoizedState: H }) | null }).alternate;
            const cur = f as F & { memoizedProps: Record<string, unknown>; memoizedState: H };
            if (alt) {
              const changed = Object.keys(cur.memoizedProps ?? {}).filter((p) => cur.memoizedProps[p] !== alt.memoizedProps?.[p]);
              const why: string[] = changed.length ? [`props:${changed.join(',')}`] : [];
              let h1 = cur.memoizedState;
              let h2 = alt.memoizedState;
              for (let i = 0; h1 && h2; i++, h1 = h1.next, h2 = h2.next) if (h1.memoizedState !== h2.memoizedState) why.push(`hook${i}`);
              const wk = `${k}:${why.join('|') || 'none'}`;
              st.roots[wk] = (st.roots[wk] ?? 0) + 1;
            }
          }
        }
        if (f.child && (!f.alternate || f.child !== f.alternate.child)) stack.push(f.child);
        if (f.sibling && f !== root.current) stack.push(f.sibling);
      }
    },
  };
  for (const kind of ['ResizeObserver', 'IntersectionObserver', 'MutationObserver'] as const) {
    const Orig = w[kind] as { new (...a: unknown[]): { observe: (...a: unknown[]) => void; unobserve?: (...a: unknown[]) => void; disconnect: () => void } };
    class Wrapped extends Orig {
      private n = 0;
      constructor(...a: unknown[]) {
        super(...a);
        st.observers[kind]++;
      }
      observe(...a: unknown[]) {
        this.n++;
        st.observed[kind]++;
        super.observe(...a);
      }
      unobserve(...a: unknown[]) {
        if (this.n > 0) {
          this.n--;
          st.observed[kind]--;
        }
        super.unobserve?.(...a);
      }
      disconnect() {
        st.observed[kind] -= this.n;
        this.n = 0;
        super.disconnect();
      }
    }
    w[kind] = Wrapped;
  }
  const si = window.setInterval.bind(window);
  const ci = window.clearInterval.bind(window);
  window.setInterval = ((fn: TimerHandler, ms?: number, ...a: unknown[]) => {
    const id = si(fn, ms, ...a);
    st.intervals.set(id, ms ?? 0);
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = ((id?: number) => {
    if (id !== undefined) st.intervals.delete(id);
    ci(id);
  }) as typeof window.clearInterval;
  const co = URL.createObjectURL.bind(URL);
  const ro = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (o: Blob | MediaSource) => {
    st.blobs.created++;
    return co(o);
  };
  URL.revokeObjectURL = (u: string) => {
    st.blobs.revoked++;
    ro(u);
  };
};

interface Perf {
  on: boolean;
  commits: number;
  renders: Record<string, number>;
  roots: Record<string, number>;
  observers: Record<string, number>;
  observed: Record<string, number>;
  intervals: Map<number, number>;
  blobs: { created: number; revoked: number };
}
const perf = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { __perf: Perf }).__perf;
    return {
      commits: p.commits,
      totalRenders: Object.values(p.renders).reduce((a, b) => a + b, 0),
      tooltipRenders: p.renders['Tooltip'] ?? 0,
      roots: p.roots,
      // App components only (Radix / Floating UI internals hidden).
      renders: Object.entries(p.renders)
        .filter(([k]) => !/^(Primitive|Popper|Tooltip|Menu|ContextMenu|DropdownMenu|Presence|Slot|Dismissable|Focus|Portal|Collection|Roving|Popover|Dialog|anon|Tip$)/.test(k))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 45),
      observers: p.observers,
      observed: p.observed,
      intervals: [...p.intervals.values()],
      blobs: p.blobs,
    };
  });
const resetPerf = (page: Page, on: boolean) =>
  page.evaluate((on) => {
    const p = (window as unknown as { __perf: Perf }).__perf;
    p.on = on;
    p.commits = 0;
    p.renders = {};
    p.roots = {};
  }, on);

async function launchApp(mock: MockServer, userData: string): Promise<{ app: ElectronApplication; page: Page; t0: number }> {
  const t0 = Date.now();
  const app = await electron.launch({
    args: ['.', '--lang=ru', '--mute-audio'],
    cwd: DESKTOP,
    env: {
      ...process.env,
      CALABA_SERVER_URL: mock.url,
      CALABA_USER_DATA: userData,
      CALABA_MULTI_INSTANCE: '1',
      CALABA_FAKE_MEDIA: '1',
      CALABA_VISUAL_TEST: '1',
      ELECTRON_RENDERER_URL: '',
      LANG: 'ru_RU.UTF-8',
    },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.setContentSize(1280, 800);
    w?.setIgnoreMouseEvents(true);
  });
  return { app, page, t0 };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

async function main() {
  const out: Record<string, unknown> = {};
  const mock = await startMockServer({ port: PORT, scenario: 'data', quiet: true } as never);
  const userData = mkdtempSync(join(tmpdir(), 'calaba-perf-'));
  try {
    // ---------------------------------------------------------------- first launch: sign in
    {
      const { app, page } = await launchApp(mock, userData);
      await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 })));
      await page.reload();
      await page.getByLabel('Email').fill('owner@calaba.test');
      await page.getByLabel('Пароль', { exact: true }).fill('password123');
      await page.getByRole('button', { name: 'Войти', exact: true }).click();
      await page.locator('aside').first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      await app.close();
    }
    // ---------------------------------------------------------------- cold starts (signed in)
    const starts: Record<string, number>[] = [];
    let last: { app: ElectronApplication; page: Page } | null = null;
    for (let i = 0; i < LAUNCHES; i++) {
      const { app, page, t0 } = await launchApp(mock, userData);
      const tWin = Date.now() - t0;
      await page.locator('aside').first().waitFor({ timeout: 30_000 });
      const tAside = Date.now() - t0;
      await page.locator('[data-virtuoso-scroller], [data-testid="message"]').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      const tFeed = Date.now() - t0;
      const nav = await page.evaluate(() => {
        const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1;
        const res = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((r) => ({ n: r.name.split('/').pop()?.slice(0, 40), d: Math.round(r.duration), s: r.decodedBodySize }));
        return { domInteractive: Math.round(n.domInteractive), dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), fcp: Math.round(fcp), aside: Math.round(performance.now()), res };
      });
      starts.push({ tWin, tAside, tFeed, ...nav, res: 0 } as never);
      if (i === 0) out['resources'] = nav.res.filter((r) => (r.s ?? 0) > 20_000 || r.d > 30);
      if (i < LAUNCHES - 1) await app.close();
      else last = { app, page };
    }
    out['coldStart'] = starts;
    out['coldStartMedian'] = Object.fromEntries(['tWin', 'tAside', 'tFeed', 'domInteractive', 'dcl', 'fcp'].map((k) => [k, median(starts.map((s) => s[k] ?? 0))]));

    const { app, page } = last as { app: ElectronApplication; page: Page };
    // Counters are injected on a reload (cold-start timings above are without them).
    const pre = await page.context().newCDPSession(page);
    await pre.send('Page.enable');
    await pre.send('Page.addScriptToEvaluateOnNewDocument', { source: `var __name = (f) => f; (${INIT.toString()})()` });
    await page.reload();
    await page.locator('aside').first().waitFor({ timeout: 30_000 });
    out['hookInstalled'] = await page.evaluate(() => '__perf' in window);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries(((await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value]));
    const delta = (a: Record<string, number>, b: Record<string, number>) =>
      Object.fromEntries(['ScriptDuration', 'TaskDuration', 'LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration'].map((k) => [k, +((b[k] ?? 0) - (a[k] ?? 0)).toFixed(3)]));
    const heap = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      await cdp.send('HeapProfiler.collectGarbage');
      const c = (await cdp.send('Memory.getDOMCounters')) as Record<string, number>;
      const h = ((await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }).usedSize;
      return { heapMB: +(h / 1048576).toFixed(2), ...c };
    };

    const openRoom = async (name: RegExp, heading: string) => {
      await page.locator('aside').getByRole('button', { name }).first().click();
      await page.getByRole('heading', { name: heading }).first().waitFor();
    };
    await openRoom(/общий/, 'общий');
    await page.waitForTimeout(1000);
    out['idleInventory'] = await perf(page);

    // ---------------------------------------------------------------- re-renders
    const post = (path: string, body: unknown) => fetch(`${mock.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const scenario = async (name: string, n: number, step: (i: number) => Promise<unknown>) => {
      await page.waitForTimeout(500);
      await resetPerf(page, true);
      const m0 = await metrics();
      for (let i = 0; i < n; i++) {
        await step(i);
        await page.waitForTimeout(300);
      }
      await page.waitForTimeout(800);
      const m1 = await metrics();
      out[`render:${name}`] = { events: n, ...(await perf(page)), cdp: delta(m0, m1) };
      await resetPerf(page, false);
    };
    await scenario('messages-open-room', 20, (i) => post('/__mock/message', { roomId: IDS.rooms.general, authorId: IDS.users.boris, content: `perf message ${i} with some **markdown** and a link https://example.com` }));
    await scenario('messages-other-room', 20, (i) => post('/__mock/message', { roomId: IDS.rooms.dev, authorId: IDS.users.boris, content: `perf other ${i}` }));
    await scenario('typing', 10, (i) => post('/__mock/typing', { roomId: IDS.rooms.general, userId: i % 2 ? IDS.users.vera : IDS.users.boris }));
    await scenario('presence', 10, (i) => post('/__mock/presence', { userId: IDS.users.grigory, status: i % 2 ? 'ONLINE' : 'IDLE' }));

    // ---------------------------------------------------------------- memory & requests while switching rooms
    const reqs: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/api/')) reqs.push(`${r.method()} ${u.pathname}${u.search}`);
    });
    const rooms: [RegExp, string][] = [
      [/общий/, 'общий'],
      [/разработка/, 'разработка'],
      [/очень-длинное/, 'очень-длинное-название-комнаты-для-проверки-обрезки'],
    ];
    const h0 = await heap();
    const round = async () => {
      for (let i = 0; i < 21; i++) {
        const [re, h] = rooms[i % 3] as [RegExp, string];
        await openRoom(re, h);
        await page.waitForTimeout(250);
      }
    };
    await resetPerf(page, true);
    const m0 = await metrics();
    await round();
    const m1 = await metrics();
    out['render:switch21'] = { ...(await perf(page)), cdp: delta(m0, m1) };
    await resetPerf(page, false);
    const h1 = await heap();
    await round();
    const h2 = await heap();
    for (let r = 0; r < 3; r++) await round();
    const h5 = await heap();
    out['heap'] = { before: h0, after21: h1, after42: h2, after105: h5 };
    const counts = new Map<string, number>();
    for (const r of reqs) counts.set(r, (counts.get(r) ?? 0) + 1);
    out['requestsDuring105Switches'] = { total: reqs.length, top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15) };
    out['afterInventory'] = await perf(page);
    await app.close();
  } finally {
    await mock.close();
    rmSync(userData, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
}

void main();
