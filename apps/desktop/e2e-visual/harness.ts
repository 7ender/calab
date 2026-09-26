import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { startMockServer, type MockServer } from '../e2e-support/mock-server';

/**
 * Harness for the design tests (docs/08, «Тесты дизайна»): the production renderer (out/)
 * against the deterministic mock API, with a fixed clock, fixed OS permission statuses
 * (CALABA_VISUAL_TEST=1), no native vibrancy and no animations.
 */

export type Theme = 'dark' | 'light';
export interface Viewport {
  width: number;
  height: number;
}
/** docs/08: the minimum window and a typical laptop window (fits a 1470×864 work area). */
export const VIEWPORTS: Viewport[] = [
  { width: 960, height: 600 },
  { width: 1440, height: 800 },
];
export const THEMES: Theme[] = ['dark', 'light'];

/**
 * A fixed port: the login screen prints the server URL, so the baseline is taken on 39170.
 * CALABA_VISUAL_MOCK_PORT lets parallel local runs coexist (their auth shots then differ).
 */
export const MOCK_PORT = Number(process.env['CALABA_VISUAL_MOCK_PORT'] ?? 39170);
/** «Now» for the client: the fixtures are dated 2026-01-14/15. */
export const NOW = new Date('2026-01-15T13:30:00+03:00');
export const PASSWORD = 'password123';

export interface Env {
  app: ElectronApplication;
  page: Page;
  mock: MockServer;
  close(): Promise<void>;
}

export async function launch(opts: { theme: Theme; viewport: Viewport; scenario?: 'data' | 'empty'; onboarded?: boolean; port?: number }): Promise<Env> {
  const mock = await startMockServer({ port: opts.port ?? MOCK_PORT, scenario: opts.scenario ?? 'data' });
  const userData = mkdtempSync(join(tmpdir(), 'calaba-visual-'));
  const app = await electron.launch({
    // --lang=ru: app.getLocale() → ru, so «as in the system» is Russian on any host (ADR-0022).
    // --mute-audio: no join/leave sounds through the machine's speakers during the run.
    args: ['.', '--lang=ru', '--mute-audio'],
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      CALABA_SERVER_URL: mock.url,
      CALABA_USER_DATA: userData,
      CALABA_MULTI_INSTANCE: '1',
      CALABA_FAKE_MEDIA: '1',
      CALABA_VISUAL_TEST: '1',
      ELECTRON_RENDERER_URL: '',
      TZ: 'Europe/Moscow',
      LANG: 'ru_RU.UTF-8',
    },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, v) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.setContentSize(v.width, v.height);
    w?.center();
    // The real (OS) cursor may sit over the window: Chromium then hovers whatever lands under it
    // (a list row after a popover opens, a menu item mid-transition). Only Playwright's
    // (CDP-dispatched) input reaches the page.
    w?.setIgnoreMouseEvents(true);
  }, opts.viewport);
  await page.clock.setFixedTime(NOW);
  await page.evaluate(
    ({ theme, onboarded }) => {
      localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme, onboarded, locale: 'ru' }, version: 1 }));
    },
    { theme: opts.theme, onboarded: opts.onboarded ?? false },
  );
  await page.reload();
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(opts.viewport.width);
  return {
    app,
    page,
    mock,
    async close() {
      await app.close().catch(() => undefined);
      await mock.close();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

export async function login(page: Page, email = 'owner@calaba.test'): Promise<void> {
  // The test window takes the OS focus: a key typed on this machine meanwhile lands in the field
  // (seen: «password123н»). Check the values right before submitting, re-fill if they drifted.
  const emailField = page.getByLabel('Email');
  const password = page.getByLabel('Пароль');
  await expect(async () => {
    await emailField.fill(email);
    await password.fill(PASSWORD);
    await expect(emailField).toHaveValue(email, { timeout: 200 });
    await expect(password).toHaveValue(PASSWORD, { timeout: 200 });
  }).toPass({ timeout: 5000 });
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

/**
 * Lets fonts, images and layout settle; parks the pointer so nothing is hovered (`keepPointer`:
 * leave it — a drag in progress follows the pointer).
 */
export async function settle(page: Page, keepPointer = false): Promise<void> {
  if (!keepPointer) await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => i.addEventListener('load', r, { once: true }))),
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // The virtualized feed measures rows and loads previews asynchronously: wait until every
    // scroller keeps the same scrollTop / scrollHeight for 300 ms (max 5 s).
    const snapshot = (): string =>
      [...document.querySelectorAll('[data-virtuoso-scroller]')].map((e) => `${e.scrollTop}:${e.scrollHeight}`).join('|');
    // (Iteration counts, not Date.now(): the page clock is frozen by page.clock.setFixedTime.)
    let last = snapshot();
    let stable = 0;
    for (let i = 0; i < 100 && stable < 6; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const now = snapshot();
      stable = now === last ? stable + 1 : 0;
      last = now;
    }
  });
}

// ---------------------------------------------------------------- layout invariants

export interface LayoutProblem {
  kind: string;
  detail: string;
}

/**
 * docs/08 «Тесты дизайна»: no horizontal scroll, text doesn't spill out of its box
 * (intended truncation with ellipsis is fine), nothing sticks out of the window, the modal
 * is centred, the stream PiP doesn't cover the composer.
 */
export async function layoutProblems(page: Page): Promise<LayoutProblem[]> {
  return page.evaluate(() => {
    const out: { kind: string; detail: string }[] = [];
    const W = innerWidth;
    const H = innerHeight;
    const describe = (el: Element): string => {
      const text = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
      const label = el.getAttribute('aria-label') ?? '';
      return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}> ${label || text}`;
    };
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
    };

    // 1. No horizontal page scroll.
    const se = document.scrollingElement ?? document.documentElement;
    if (se.scrollWidth > se.clientWidth + 1) out.push({ kind: 'h-scroll', detail: `page ${se.scrollWidth} > ${se.clientWidth}` });
    for (const el of document.querySelectorAll('main, aside, section, [role="dialog"], [role="tabpanel"]')) {
      const cs = getComputedStyle(el);
      if (!visible(el) || cs.overflowX === 'hidden' || cs.overflowX === 'clip') continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push({ kind: 'h-scroll', detail: `${describe(el)}: ${el.scrollWidth} > ${el.clientWidth}` });
    }

    // 2. Text overflow in key containers: controls, headings, list rows, tabs, labels. Every
    //    text node must lie inside its container, unless an ancestor clips it on purpose —
    //    then the clip must show an ellipsis. Absolutely positioned badges are exempt.
    const keys = 'button, a, h1, h2, h3, label, [role="tab"], [role="option"], [role="menuitem"], th, td, kbd';
    const srOnly = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return r.width <= 1 || r.height <= 1;
    };
    for (const el of document.querySelectorAll<HTMLElement>(keys)) {
      if (!visible(el) || srOnly(el) || el.closest('[data-layout-ignore]')) continue;
      const box = el.getBoundingClientRect();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!(n.textContent ?? '').trim()) continue;
        const parent = n.parentElement;
        if (!parent || !visible(parent) || srOnly(parent)) continue;
        // Skip text inside absolutely positioned descendants (badges) and inside clipping boxes.
        let clipper: HTMLElement | null = null;
        let abs = false;
        for (let a: HTMLElement | null = parent; a && a !== el.parentElement; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (a !== el && (cs.position === 'absolute' || cs.position === 'fixed')) abs = true;
          if (!clipper && (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflowX === 'auto')) clipper = a;
        }
        if (abs) continue;
        if (clipper) {
          const cs = getComputedStyle(clipper);
          // An intentional fade-out (mask) instead of an ellipsis counts as proper truncation.
          let faded = false;
          for (let a: HTMLElement | null = clipper; a && a !== el.parentElement; a = a.parentElement) {
            const m = getComputedStyle(a);
            const mask = m.maskImage || m.getPropertyValue('-webkit-mask-image');
            if (mask && mask !== 'none') faded = true;
          }
          if (!faded && clipper.scrollWidth > clipper.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.overflowX !== 'auto') {
            out.push({ kind: 'text-clipped', detail: `${describe(el)}: clipped without ellipsis` });
          }
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) {
          out.push({ kind: 'text-overflow', detail: `${describe(el)}: text ${Math.round(r.width)}×${Math.round(r.height)} outside ${Math.round(box.width)}×${Math.round(box.height)}` });
        }
      }
    }
    // 2b. Truncated labels must keep a readable width (a name squeezed to nothing by a
    //     neighbour is as broken as an overflowing one).
    for (const el of document.querySelectorAll<HTMLElement>('.truncate')) {
      const text = el.textContent.trim();
      if (!text || el.closest('[data-layout-ignore], .sr-only')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      let hidden = false;
      for (let a: HTMLElement | null = el.parentElement; a; a = a.parentElement) {
        const acs = getComputedStyle(a);
        if (acs.display === 'none' || acs.visibility === 'hidden' || Number(acs.opacity) === 0) hidden = true;
      }
      if (hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width < Math.min(24, text.length * 6)) out.push({ kind: 'text-squeezed', detail: `${describe(el)}: ${Math.round(r.width)} px wide` });
    }
    // 3. Nothing interactive sticks out of the window.
    for (const el of document.querySelectorAll('button, input, select, textarea, [role="dialog"]')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      // Elements inside scroll containers may legitimately be scrolled out of view.
      let p = el.parentElement;
      let scrolled = false;
      while (p) {
        const o = getComputedStyle(p).overflowY;
        if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) scrolled = true;
        p = p.parentElement;
      }
      if (scrolled) continue;
      if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) {
        out.push({ kind: 'offscreen', detail: `${describe(el)}: ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}` });
      }
    }
    // 4. Modals centred (anchored popovers also use role="dialog", but without aria-modal).
    for (const d of document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) {
      if (!visible(d) || d.hasAttribute('data-layout-anchor')) continue;
      const r = d.getBoundingClientRect();
      const dx = Math.abs(r.left + r.width / 2 - W / 2);
      const dy = Math.abs(r.top + r.height / 2 - H / 2);
      if (dx > 2 || dy > 2) out.push({ kind: 'modal-off-centre', detail: `${describe(d)}: Δx=${dx.toFixed(1)} Δy=${dy.toFixed(1)}` });
    }
    // 5. PiP vs composer.
    const pip = document.querySelector('[data-testid="stream-pip"]');
    const composer = document.querySelector('[data-testid="composer"]');
    if (pip && composer && visible(pip)) {
      const a = pip.getBoundingClientRect();
      const b = composer.getBoundingClientRect();
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
        out.push({ kind: 'pip-over-composer', detail: `pip bottom ${Math.round(a.bottom)} > composer top ${Math.round(b.top)}` });
      }
    }
    return out;
  });
}

export async function expectLayout(page: Page, name: string): Promise<void> {
  const problems = await layoutProblems(page);
  expect.soft(problems, `layout invariants: ${name}`).toEqual([]);
}

// ---------------------------------------------------------------- accessibility

/** axe-core, WCAG 2.x A/AA: no serious or critical violations (contrast ≥ 4.5:1 is one of them). */
export async function expectAccessible(page: Page, name: string): Promise<void> {
  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // <video> frames / canvases are content, not UI chrome.
    .exclude('video')
    // Electron can't open the extra page axe uses to merge frame results.
    .setLegacyMode(true)
    .analyze();
  const bad = res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`) }));
  expect.soft(bad, `axe: ${name}`).toEqual([]);
}

// ---------------------------------------------------------------- one checkpoint

export interface Shot {
  page: Page;
  theme: Theme;
  viewport: Viewport;
}

/** Screenshot + layout invariants + axe for the current screen. */
export async function checkpoint(s: Shot, name: string, opts: { mask?: Locator[]; axe?: boolean; keepPointer?: boolean } = {}): Promise<void> {
  await settle(s.page, opts.keepPointer);
  await expect.soft(s.page, `screenshot: ${name}`).toHaveScreenshot(`${name}-${s.theme}-${s.viewport.width}.png`, {
    mask: opts.mask ?? [],
    maskColor: '#808080',
  });
  await expectLayout(s.page, `${name} (${s.theme}, ${s.viewport.width})`);
  if (opts.axe !== false) await expectAccessible(s.page, `${name} (${s.theme}, ${s.viewport.width})`);
}
