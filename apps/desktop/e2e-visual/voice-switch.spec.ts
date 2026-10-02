import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { IDS } from '../e2e-support/fixtures';

/**
 * Room switch never hangs in «Подключение…» (docs/09 #131): in voice room A, a click on voice
 * room B → the island shows B connected and LiveKit really is in B; ten fast clicks between the
 * two end connected in the last one clicked. Behaviour only, no screenshots.
 *
 * Self-contained like deafen.spec.ts: the mock API serving dist-web (`pnpm build:web`) on
 * CALABA_SWITCH_MOCK_PORT (or CALABA_VISUAL_MOCK_PORT + 7, default 39482) + the dev LiveKit
 * (`pnpm infra:dev`); MOCK_LIVEKIT_ROOM_PREFIX for parallel runs. Chromium only.
 *
 *   pnpm -F @calaba/desktop exec playwright test --config playwright.visual.config.ts --project voice-switch
 */

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist-web');
const PORT = Number(process.env['CALABA_SWITCH_MOCK_PORT'] ?? Number(process.env['CALABA_VISUAL_MOCK_PORT'] ?? 39475) + 7);
const BASE = `http://127.0.0.1:${PORT}`;

test.skip(({ browserName }) => browserName !== 'chromium' || process.env['CALABA_WEB_URL'] !== undefined, 'self-contained mock run, Chromium');

let mock: ChildProcess | undefined;
test.beforeAll(async ({ browserName }) => {
  if (browserName !== 'chromium' || process.env['CALABA_WEB_URL'] !== undefined) return;
  expect(existsSync(join(DIST, 'index.html')), 'dist-web is missing: run `pnpm build:web` first').toBe(true);
  const proc = spawn(process.execPath, ['--import', 'tsx', 'e2e-support/mock-server.ts', '--port', String(PORT), '--static', DIST, '--quiet'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  mock = proc;
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('mock server did not start')), 30_000);
    proc.stdout.on('data', (b: Buffer) => {
      if (b.toString().includes('Calaba mock server')) {
        clearTimeout(timer);
        ok();
      }
    });
    proc.on('exit', (code) => fail(new Error(`mock server exited: ${String(code)}`)));
  });
});
test.afterAll(() => {
  mock?.kill('SIGTERM');
});

/** The LiveKit room this client is really connected to (VoiceBar exposes voice.linkTruth in visual-test mode). */
function linkTruth(page: Page): Promise<{ state: string | null; room: string | null }> {
  return page.evaluate<{ state: string | null; room: string | null }>(`window.__calabaVoiceLink ? window.__calabaVoiceLink() : { state: null, room: null }`);
}

// A row click opens the chat; «Войти» (revealed on hover) joins the voice.
async function joinRoom(page: Page, name: string): Promise<void> {
  await page.locator('aside button', { hasText: name }).first().hover();
  await page.getByRole('button', { name: `Войти в голос «${name}»` }).click();
}

test('switching voice rooms: B connected after A; ten fast clicks end connected in the last one', async ({ page, request }) => {
  test.setTimeout(120_000);
  expect((await request.post(`${BASE}/__mock/reset`, { data: {} })).ok()).toBe(true);
  await page.goto(`${BASE}/?visual-test`);
  await page.evaluate(`localStorage.setItem('calaba-prefs', ${JSON.stringify(JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 }))})`);
  await page.reload();
  await page.getByLabel('Email').fill('owner@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();

  // A: «Созвон».
  await joinRoom(page, 'Созвон');
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await linkTruth(page)).room ?? '', { timeout: 15_000 }).toContain(IDS.rooms.call);

  // A → B: «Переговорка».
  await joinRoom(page, 'Переговорка');
  await expect.poll(async () => linkTruth(page), { timeout: 20_000 }).toMatchObject({ state: 'connected', room: expect.stringContaining(IDS.rooms.meeting) as unknown as string });
  await expect(page.getByText('Голос подключён')).toBeVisible();
  await expect(page.getByText('Подключение…')).toHaveCount(0);

  // Ten fast switches without waiting: the last click wins, nothing stays connecting.
  const order = ['Созвон', 'Переговорка'];
  for (let i = 0; i < 10; i++) await joinRoom(page, order[i % 2] ?? 'Созвон');
  // i = 9 → «Переговорка».
  await expect.poll(async () => linkTruth(page), { timeout: 30_000 }).toMatchObject({ state: 'connected', room: expect.stringContaining(IDS.rooms.meeting) as unknown as string });
  await expect(page.getByText('Голос подключён')).toBeVisible();
  // The server agrees: this device sits in B.
  const voice = (await (await request.get(`${BASE}/__mock/voice`)).json()) as Record<string, { roomId: string } | undefined>;
  expect(voice[IDS.users.anna]?.roomId).toBe(IDS.rooms.meeting);
});
