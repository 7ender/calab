import { expect, test, type Page } from '@playwright/test';
import { launch, login, type Env } from './harness';

/**
 * docs/08 «Тесты UI»: every control reached with Tab shows a focus ring. Walks the main
 * window and the settings window with the keyboard only.
 */

interface Stop {
  what: string;
  ring: boolean;
}

async function tabWalk(page: Page, max: number): Promise<Stop[]> {
  const stops: Stop[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1;
      const shadow = cs.boxShadow !== 'none' && /\d+px \d+px 0px \d+px/.test(cs.boxShadow); // ring-style spread
      // A composite control may draw the ring on its box (e.g. the composer: focus-within).
      const box = el.closest('[data-focus-box]');
      let boxRing = false;
      if (box) {
        const probe = document.createElement('span');
        probe.style.color = 'var(--color-accent)';
        document.body.appendChild(probe);
        boxRing = getComputedStyle(box).borderTopColor === getComputedStyle(probe).color;
        probe.remove();
      }
      // A shaped element (a chat bubble with its tail) draws the ring on its shape child as a
      // stack of drop-shadows that follow the outline instead of a rectangular outline.
      const shape = el.querySelector(':scope > [data-focus-shape]');
      const shapeRing = !!shape && getComputedStyle(shape).filter.includes('drop-shadow');
      const label = el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 30);
      const key = `${el.tagName}|${label}|${Math.round(el.getBoundingClientRect().left)}|${Math.round(el.getBoundingClientRect().top)}`;
      return { what: `<${el.tagName.toLowerCase()} role=${el.getAttribute('role') ?? ''}> ${label}`, ring: outline || shadow || boxRing || shapeRing, key };
    });
    if (!stop) continue;
    if (seen.has(stop.key)) break; // wrapped around
    seen.add(stop.key);
    stops.push({ what: stop.what, ring: stop.ring });
  }
  return stops;
}

let env: Env | undefined;
test.afterEach(async () => {
  await env?.close();
});

test('focus ring on every Tab stop', async () => {
  env = await launch({ theme: 'dark', viewport: { width: 1440, height: 800 }, onboarded: true });
  const { page } = env;
  await login(page);
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();

  const main = await tabWalk(page, 80);
  expect(main.length, 'Tab reaches the controls of the main window').toBeGreaterThan(10);
  expect(main.filter((s) => !s.ring).map((s) => s.what), 'main window: stops without a focus ring').toEqual([]);

  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const settings = await tabWalk(page, 60);
  expect(settings.length).toBeGreaterThan(3);
  expect(settings.filter((s) => !s.ring).map((s) => s.what), 'settings: stops without a focus ring').toEqual([]);
});
