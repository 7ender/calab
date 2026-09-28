import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Lazy Tip (components/ui.tsx) vs. clicks, on the voice panel — the 0.7.0 regression: the first
 * mouse move over a bare Tip child remounts it under the Radix trigger; when that render landed
 * after the press (a busy main thread in a call, Playwright's move → down) the press went down on
 * the old node and up on the new one, and the click was lost (camera preview never opened,
 * «Отключиться» did nothing). Self-contained like mobile.web.spec.ts: dist-web (`pnpm build:web`)
 * served by the mock API (port CALABA_WEB_MOCK_PORT, default 39520); voice needs the dev LiveKit
 * (`pnpm infra:dev`). Mock-only: skipped against a real server (CALABA_WEB_URL).
 */

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist-web');
const PORT = Number(process.env['CALABA_WEB_MOCK_PORT'] ?? 39520);
const BASE = `http://127.0.0.1:${PORT}`;

test.skip(!!process.env['CALABA_WEB_URL'], 'mock only');

let mock: ChildProcess | undefined;
test.beforeAll(async () => {
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

/**
 * The race made deterministic: a mouse move over a bare Tip child must swap in the woken element
 * before the move's dispatch returns — i.e. before any press that follows it can be delivered.
 */
async function expectWakesSynchronously(page: Page, selector: string): Promise<void> {
  const button = page.locator(selector);
  // Bare: no Radix trigger yet (it sets data-state).
  await expect(button).not.toHaveAttribute('data-state');
  // A string script: the e2e files are compiled without the DOM lib.
  const replaced = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, composed: true, pointerType: 'mouse', isPrimary: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    return !el.isConnected;
  })()`);
  expect(replaced, 'the woken Tip is committed within the waking pointermove').toBe(true);
  await expect(button).toHaveAttribute('data-state');
}

test('voice panel: camera and «Отключиться» click through a lazy Tip', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'fake camera + dev LiveKit: Chromium');
  test.setTimeout(90_000);
  await page.goto(`${BASE}/`);
  await page.evaluate(`localStorage.setItem('calaba-prefs', ${JSON.stringify(JSON.stringify({ state: { theme: 'dark', onboarded: true, locale: 'ru' }, version: 1 }))})`);
  await page.reload();
  await page.getByLabel('Email').fill('owner@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();

  await page.locator('aside button', { hasText: 'Созвон' }).first().click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });

  const camera = page.getByTestId('camera-button');
  await expectWakesSynchronously(page, '[data-testid="camera-button"]');
  await camera.click();
  await expect(page.getByTestId('camera-preview-enable')).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId('camera-preview-enable').click();
  await expect(camera).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
  await camera.click();
  await expect(camera).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });

  const leave = page.getByRole('button', { name: 'Отключиться' });
  await expectWakesSynchronously(page, 'button[aria-label="Отключиться"]');
  await leave.click();
  await expect(page.getByText('Голос подключён')).toHaveCount(0);
});
