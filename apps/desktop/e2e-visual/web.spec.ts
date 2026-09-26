import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startMockServer, type MockServer } from '../e2e-support/mock-server';
import { NOW, PASSWORD, THEMES, VIEWPORTS, checkpoint, type Shot } from './harness';

/**
 * Web client chrome (docs/09 #46, ADR-0015): the production web build (dist-web, `pnpm build:web`)
 * served same-origin by the mock API, in Playwright's Chromium with `?visual-test`. Covers the
 * compact 30 px top bar: no reserved traffic-light inset, ← → at the left edge, the workspace
 * centred, «Упоминания» and «?» on the right; the search pill only below 1200 px (from 1200 the
 * room header has its own field). Screenshot of the whole window + of the bar, layout + axe.
 */

const DIST = join(import.meta.dirname, '..', 'dist-web');

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`web top bar: ${theme} ${viewport.width}`, async ({ page }) => {
      expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
      let mock: MockServer | undefined;
      try {
        mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
        await page.setViewportSize(viewport);
        await page.clock.setFixedTime(NOW);
        await page.goto(`${mock.url}/?visual-test`);
        await page.evaluate((t) => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: t, onboarded: true, locale: 'ru' }, version: 1 })), theme);
        await page.reload();
        await page.getByLabel('Email').fill('owner@calaba.test');
        await page.getByLabel('Пароль').fill(PASSWORD);
        await page.getByRole('button', { name: 'Войти', exact: true }).click();
        await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
        await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();

        const bar = page.getByTestId('titlebar');
        await expect(bar).toHaveAttribute('data-variant', 'web');
        const box = await bar.boundingBox();
        expect(box?.height, 'web top bar height').toBe(30);
        expect(box?.y).toBe(0);
        // No traffic-light inset: ← sits at the left edge (8 px padding).
        const back = await bar.getByRole('button', { name: 'Назад' }).boundingBox();
        expect(back?.x ?? 99, '← at the left edge').toBeLessThanOrEqual(12);
        // Workspace icon + name centred in the window (±4 px).
        const title = await bar.locator('[title="Команда Calab"]').boundingBox();
        expect(Math.abs((title ? title.x + title.width / 2 : 0) - viewport.width / 2), 'workspace name centred').toBeLessThanOrEqual(4);
        await expect(bar.getByRole('button', { name: /^Упоминания/ })).toBeVisible();
        await expect(bar.getByRole('button', { name: 'Горячие клавиши' })).toBeVisible();
        // The search pill: below 1200 px only (the room header has the field from 1200).
        const search = bar.getByRole('button', { name: 'Поиск' });
        if (viewport.width >= 1200) await expect(search).toBeHidden();
        else await expect(search).toBeVisible();

        const s: Shot = { page, theme, viewport };
        // The feed opens at the first unread; that anchor lands a few px apart between runs:
        // pin the shot to the bottom of the feed (as the Electron main-chat shot does).
        await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
        await checkpoint(s, 'web-main');
        await expect.soft(bar, 'screenshot: web-titlebar').toHaveScreenshot(`web-titlebar-${theme}-${viewport.width}.png`);
      } finally {
        await mock?.close();
      }
    });
  }
}

/**
 * Web link page (docs/09 #53): /join/<code> and /r/<code> show a card — «Открыть в Calab»,
 * «Продолжить в браузере», «Скачать приложение» — before any web flow. `?visual-test` keeps the
 * `calab://` launch inside the page (no OS hand-off), so the «Приложение не найдено» state comes
 * from the probe's own timeout: the page never loses focus here.
 */
async function openLink(page: import('@playwright/test').Page, base: string, path: string, theme: string, extra: Record<string, string> = {}): Promise<void> {
  await page.goto(`${base}/?visual-test`);
  await page.evaluate(
    ({ t, e }) => {
      localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: t, onboarded: true, locale: 'ru' }, version: 1 }));
      for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v);
    },
    { t: theme, e: extra },
  );
  await page.goto(`${base}${path}?visual-test`);
  await expect(page.getByTestId('link-landing')).toBeVisible();
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`web join card: ${theme} ${viewport.width}`, async ({ page }) => {
      expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
      let mock: MockServer | undefined;
      try {
        mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
        await page.setViewportSize(viewport);
        await page.clock.setFixedTime(NOW);
        await openLink(page, mock.url, '/join/calaba-team-2026', theme);
        const card = page.getByTestId('link-landing');
        // Signed out: GET /api/invites/{code} needs a session, so the card names no workspace.
        await expect(card.getByRole('heading', { name: 'Вас пригласили в пространство' })).toBeVisible();
        const open = card.getByRole('button', { name: 'Открыть в Calab' });
        const browser = card.getByRole('button', { name: 'Продолжить в браузере' });
        const download = card.getByRole('link', { name: 'Скачать приложение' });
        await expect(download).toHaveAttribute('href', '/download/');
        // Focus order: open → browser → download → «always in the app».
        await open.focus();
        await page.keyboard.press('Tab');
        await expect(browser).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(download).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(card.getByRole('checkbox', { name: 'Всегда открывать в приложении' })).toBeFocused();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

        const s: Shot = { page, theme, viewport };
        await checkpoint(s, 'web-join-card');

        // «Открыть в Calab» without an app: after the timeout — «Приложение не найдено» (role=status),
        // «Продолжить в браузере» becomes the primary action and takes the focus.
        await open.click();
        const status = card.getByRole('status');
        await expect(status).toContainText('Приложение не найдено', { timeout: 5000 });
        await expect(card.getByRole('button', { name: 'Продолжить в браузере' })).toBeFocused();
        await expect(card.getByRole('link', { name: 'Скачать приложение' })).toBeVisible();
        await expect(card.getByRole('button', { name: 'Открыть в Calab ещё раз' })).toBeVisible();
        // «Всегда открывать в приложении» contradicts «не найдено»: hidden in this state.
        await expect(card.getByRole('checkbox')).toHaveCount(0);
        await checkpoint(s, 'web-join-card-not-found');

        // «Продолжить в браузере» → the regular web flow: registration with the invite code.
        await card.getByRole('button', { name: 'Продолжить в браузере' }).click();
        await expect(page.getByTestId('link-landing')).toHaveCount(0);
        await expect(page.getByLabel('Код приглашения')).toHaveValue('calaba-team-2026');
        expect(new URL(page.url()).pathname).toBe('/');
      } finally {
        await mock?.close();
      }
    });
  }
}

test('web link card: room preview, «always in the app», signed in', async ({ page }) => {
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  let mock: MockServer | undefined;
  try {
    mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.clock.setFixedTime(NOW);

    // /r/<code>: the public preview names the room and the workspace.
    await openLink(page, mock.url, '/r/call-guest-link', 'dark');
    const card = page.getByTestId('link-landing');
    await expect(card.getByRole('heading', { name: /Созвон/ })).toBeVisible();
    await expect(card.getByText('в «Команда Calab»')).toBeVisible();

    // «Всегда открывать в приложении»: remembered; on arrival the app is tried right away, with
    // a visible way back to the browser.
    await card.getByRole('checkbox', { name: 'Всегда открывать в приложении' }).check();
    await page.reload();
    await expect(card.getByRole('status')).toContainText('Открываем Calab');
    await expect(card.getByRole('status').getByRole('button', { name: 'Открыть в браузере' })).toBeVisible();
    await expect(card.getByRole('status')).toContainText('Приложение не найдено', { timeout: 5000 });
    await expect(card.getByRole('checkbox', { name: 'Всегда открывать в приложении' })).toBeChecked();
    await card.getByRole('checkbox', { name: 'Всегда открывать в приложении' }).uncheck();

    // Signed in: the card is still shown (no jump), now with the workspace name.
    await card.getByRole('button', { name: 'Продолжить в браузере' }).click();
    await page.getByRole('button', { name: 'Войти', exact: true }).click(); // guest screen → login
    await page.getByLabel('Email').fill('owner@calaba.test');
    await page.getByLabel('Пароль').fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Войти в комнату «Созвон» пространства «Команда Calab»?' })).toBeVisible();
    await page.goto(`${mock.url}/join/calaba-team-2026?visual-test`);
    await expect(page.getByTestId('link-landing').getByRole('heading', { name: 'Команда Calab' })).toBeVisible();
  } finally {
    await mock?.close();
  }
});
