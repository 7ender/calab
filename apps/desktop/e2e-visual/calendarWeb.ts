import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import { IDS, startMockServer, type AddEventArgs, type MockServer } from '../e2e-support/mock-server';
import { NOW, PASSWORD } from './harness';

/**
 * Calendar behaviour specs (ADR-0038, docs/20 (c)): the production web build (dist-web) served
 * same-origin by the mock API, in Chromium with the Moscow zone, the page and the mock frozen at
 * NOW (15 January 2026, 13:30 MSK). No screenshots here — the calendar's baselines are in
 * screens.spec.ts / mobile.visual.spec.ts.
 *
 *   pnpm -F @calaba/desktop build:web && pnpm -F @calaba/desktop exec playwright test --config playwright.visual.config.ts --project calendar
 */

const DIST = join(import.meta.dirname, '..', 'dist-web');
export const DAY = '2026-01-15';
/** 15:00 MSK on NOW's day. */
export const AT_15 = Date.parse('2026-01-15T12:00:00Z');
export const HOUR = 3_600_000;

export const test = base.extend<{ mock: MockServer }>({
  // eslint-disable-next-line no-empty-pattern
  mock: async ({}, use) => {
    expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
    const mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST });
    mock.setClock(NOW.getTime());
    await use(mock);
    await mock.close();
  },
});

export { expect };

/** Opens `path` (default the app) signed in as `email` (Анна by default), dark theme, Russian UI. */
export async function signIn(page: Page, mock: MockServer, path = '/', email = 'owner@calaba.test'): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(`${mock.url}/?visual-test`);
  await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 })));
  await page.goto(`${mock.url}${path}${path.includes('?') ? '&' : '?'}visual-test`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.locator('aside').first()).toBeVisible({ timeout: 30_000 });
}

/** The header icon → the mini month → NOW's day: the day view. */
export async function openDay(page: Page, day = DAY): Promise<void> {
  const mini = page.getByTestId('mini-calendar');
  if (!(await mini.isVisible())) await page.getByTestId('calendar-button').click();
  await mini.locator(`[data-cal-day="${day}"]`).click();
  await expect(page.getByTestId('day-view')).toBeVisible();
}

/** «Планёрка» 15:00–16:00 MSK in «Переговорка», organized by Борис, Анна invited (optional external too). */
export function planerka(mock: MockServer, extra: Partial<AddEventArgs> = {}): string {
  return mock.addEvent({
    workspaceId: IDS.workspaces.main,
    organizerId: IDS.users.boris,
    title: 'Планёрка',
    description: 'Повестка: релиз 1.0',
    startMs: AT_15,
    endMs: AT_15 + HOUR,
    roomId: IDS.rooms.meeting,
    attendees: [{ userId: IDS.users.anna }, { userId: IDS.users.vera, required: false }, { email: 'ext@example.com', required: false }],
    ...extra,
  }).id;
}
