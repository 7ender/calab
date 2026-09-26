import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { IDS, MARKETING_IDS, startMockServer } from '../e2e-support/mock-server';
import { NOW } from '../e2e-visual/harness';
import { startPublisher } from '../e2e-visual/publisher';

/**
 * README / landing screenshots (docs/09 #52): the packaged app (vibrancy, the system window frame
 * and shadow), mock data, captured by the window server with `screencapture -l` at the display's
 * native 2x. No resizing, no 1x copies. `<name>-<theme>@2x.png` has no shadow (exact window size);
 * `chat-<theme>-shadow@2x.png` keeps the system shadow for the hero.
 * Data: the mock's `marketing` scenario (e2e-support/fixtures-marketing.ts); Вера shares a
 * release checklist slide (e2e-support/assets/stream-slide.png).
 */
const APP = process.env['CALABA_APP'] ?? resolve(import.meta.dirname, '../dist/mac-arm64/Calab.app/Contents/MacOS/Calab');
const OUT = resolve(import.meta.dirname, '../../../docs/images');
const WINDOW = { width: 1440, height: 900 };
const PORT = 39180;

test.skip(process.platform !== 'darwin', 'macOS only');

function windowId(owner: string): string {
  const out = execFileSync('swift', [resolve(import.meta.dirname, '../scripts/window-id.swift'), owner], { encoding: 'utf8' });
  // "<id> <width> <height> <title>" per on-screen window; the main window is the largest.
  const rows = out.trim().split('\n').filter(Boolean).map((l) => l.split(' '));
  rows.sort((a, b) => Number(b[1]) * Number(b[2]) - Number(a[1]) * Number(a[2]));
  const id = rows[0]?.[0];
  if (!id) throw new Error(`no on-screen window for ${owner}`);
  return id;
}

const frontmostPid = (): string =>
  execFileSync('osascript', ['-e', 'tell application "System Events" to get unix id of first process whose frontmost is true'], { encoding: 'utf8' }).trim();

/** The app is frontmost and its main window is key. */
async function isActive(app: ElectronApplication): Promise<boolean> {
  return frontmostPid() === String(app.process().pid) && (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused() ?? false));
}

/**
 * Makes the main window key in the frontmost app: the window server draws an inactive window
 * with grey traffic lights (Electron's isFocused() can be true while another app is active).
 */
async function activate(app: ElectronApplication): Promise<boolean> {
  const pid = app.process().pid;
  if (frontmostPid() !== String(pid)) {
    execFileSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]);
  }
  await app.evaluate(({ app: a, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.show();
    a.focus({ steal: true });
    w?.focus();
  });
  return isActive(app);
}

async function shoot(app: ElectronApplication, page: Page, name: string, shadow = false): Promise<void> {
  await expect.poll(() => activate(app)).toBe(true);
  // No focus rings / hover-revealed controls (e.g. the stream toolbar shows on focus-within).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(WINDOW.width - 2, WINDOW.height - 2);
  await page.waitForTimeout(1200); // vibrancy + fonts + animations settle
  const id = windowId('Calab');
  const file = join(OUT, `${name}@2x.png`);
  // Another app may take focus while we wait: re-activate and capture until the window stayed key.
  for (let attempt = 0; ; attempt++) {
    await expect.poll(() => activate(app)).toBe(true);
    await page.waitForTimeout(400); // the frame redraws as active
    execFileSync('screencapture', ['-x', ...(shadow ? [] : ['-o']), `-l${id}`, file]);
    if ((await isActive(app)) || attempt >= 4) break;
  }
  const size = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
  console.log(name, size.replace(/\s+/g, ' ').trim(), `${(statSync(file).size / 1e6).toFixed(1)} MB`);
}

for (const theme of ['dark', 'light'] as const) {
  test(`marketing ${theme}`, async () => {
    const mock = await startMockServer({ port: PORT, scenario: 'marketing' });
    const userData = mkdtempSync(join(tmpdir(), 'calab-shots-'));
    const app = await electron.launch({
      executablePath: APP,
      env: {
        ...process.env,
        CALABA_SERVER_URL: mock.url,
        CALABA_USER_DATA: userData,
        CALABA_MULTI_INSTANCE: '1',
        CALABA_FAKE_MEDIA: '1',
        CALABA_VISUAL_TEST: '1',
        TZ: 'Europe/Moscow',
        LANG: 'ru_RU.UTF-8',
      },
    });
    let publisher: Awaited<ReturnType<typeof startPublisher>> | null = null;
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }, v) => {
        const w = BrowserWindow.getAllWindows()[0];
        w?.setSize(v.width, v.height);
        w?.center();
      }, WINDOW);
      await page.clock.setFixedTime(NOW);
      await page.evaluate((t) => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: t, onboarded: false }, version: 1 })), theme);
      await page.reload();

      // ---- sign in → onboarding «Как включать микрофон»
      await page.getByLabel('Email').fill('owner@calaba.test');
      await page.getByLabel('Пароль').fill('password123');
      await page.getByRole('button', { name: 'Войти', exact: true }).click();
      await page.getByRole('button', { name: 'Разрешить микрофон' }).click();
      await page.getByRole('button', { name: 'Слышно хорошо' }).click();
      await expect(page.getByTestId('onboarding-mode')).toBeVisible();
      await shoot(app, page, `onboarding-${theme}`);
      await page.getByRole('button', { name: 'Пропустить настройку' }).click();

      // ---- chat (hero)
      await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
      await expect(page.locator('[data-message-id]').first()).toBeVisible();
      await page.waitForTimeout(800);
      await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      await shoot(app, page, `chat-${theme}`);
      await shoot(app, page, `chat-${theme}-shadow`, true);

      // ---- room settings → «Ссылка для гостей»
      await page.getByRole('button', { name: 'Настройки комнаты' }).click();
      await page.getByRole('dialog').getByRole('tab', { name: 'Ссылка для гостей' }).click();
      // Shared links are built from the server URL; show the product domain instead of the mock's.
      await expect(page.getByRole('dialog').getByText(`${mock.url}/r/`)).toBeVisible();
      await page.getByRole('dialog').evaluate((dialog, from) => {
        const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) n.nodeValue = n.nodeValue?.replaceAll(from, 'https://calab.ru') ?? null;
      }, mock.url);
      await shoot(app, page, `settings-${theme}`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // ---- voice room with a screen share on the stage
      await page.locator('aside').getByRole('button', { name: /Переговорка/ }).first().click();
      await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
      const sidebar = page.locator('aside').first();
      await sidebar.getByTestId('voice-status-row').click();
      await sidebar.getByTestId('voice-status-input').fill('Планёрка по релизу 0.2');
      await sidebar.getByTestId('voice-status-input').press('Enter');
      await expect(sidebar.getByTestId('voice-status-row')).toContainText('Планёрка по релизу 0.2');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      publisher = await startPublisher({
        userId: IDS.users.vera,
        name: 'Вера Ким',
        roomId: MARKETING_IDS.rooms.meeting,
        image: readFileSync(resolve(import.meta.dirname, '../e2e-support/assets/stream-slide.png')),
      });
      const video = page.locator('video');
      const chip = page.getByRole('button', { name: 'Вера Ким', exact: true });
      await expect(video.or(chip).first()).toBeVisible({ timeout: 30_000 });
      if ((await video.count()) === 0) await chip.first().click();
      await expect.poll(() => video.first().evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.videoWidth > 0), { timeout: 30_000 }).toBe(true);
      const expand = page.getByTestId('stream-pip').getByRole('button', { name: 'Развернуть' });
      if (await expand.count()) await expand.first().click();
      await expect(page.getByTestId('stream-stage')).toBeVisible();
      await shoot(app, page, `stream-${theme}`);
      await page.getByRole('button', { name: 'Отключиться' }).click();
    } finally {
      await publisher?.stop();
      await app.close().catch(() => undefined);
      await mock.close();
      rmSync(userData, { recursive: true, force: true });
    }
  });
}
