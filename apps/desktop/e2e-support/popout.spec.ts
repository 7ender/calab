import type { BrowserWindow } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, loadConfigFromFile, type ViteDevServer, type UserConfig } from 'vite';
import { IDS, startMockServer, type MockServer } from '../e2e-support/mock-server';

// Behavioral regression, not a visual suite. Build main/preload first with pnpm build:app.
const base = resolve(import.meta.dirname, '..');
const port = Number(process.env['CALABA_POPOUT_TEST_PORT'] ?? 40780);
const fixture = `/@fs${join(base, 'e2e-support/popout-stream.ts')}`;
let app: ElectronApplication | undefined;
let page: Page;
let server: ViteDevServer | undefined;
let mock: MockServer | undefined;
let userData: string;

test.beforeAll(async () => {
  mock = await startMockServer({ port: port + 1 });
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, join(base, 'electron.vite.config.ts'));
  const options = loaded?.config as { renderer: UserConfig };
  server = await createServer({ ...options.renderer, configFile: false, server: { host: '127.0.0.1', port, strictPort: true } });
  await server.listen();
  userData = mkdtempSync(join(tmpdir(), 'calab-popout-'));
  app = await electron.launch({ args: ['.', '--mute-audio', '--lang=ru'], cwd: base, env: {
    ...process.env, CALABA_SERVER_URL: mock.url, CALABA_USER_DATA: userData,
    CALABA_MULTI_INSTANCE: '1', CALABA_FAKE_MEDIA: '1', CALABA_VISUAL_TEST: '1',
    ELECTRON_RENDERER_URL: `http://127.0.0.1:${port}`,
  } });
  page = await app.firstWindow();
  await page.evaluate(() => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { onboarded: true, locale: 'ru' }, version: 1 })));
  await page.reload();
  await page.getByLabel('Email').fill('owner@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.locator('aside').first()).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  await server?.close();
  await mock?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

test('detached stream survives navigation, follows its own visibility and cleans up', async ({ browserName: _browserName }, testInfo) => {
  if (!app) throw new Error('No Electron app');
  const client = app;
  await page.evaluate(async ({ fixture, ids }) => {
    const driver = await import(/* @vite-ignore */ fixture) as typeof import('../e2e-support/popout-stream');
    driver.start(ids.workspaces.main, ids.rooms.meeting, ids.users.vera);
  }, { fixture, ids: IDS });
  const stage = page.getByTestId('stream-stage');
  await expect(stage).toBeVisible();
  await expect.poll(() => stage.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  const open = async (): Promise<Page> => {
    await stage.getByRole('button', { name: 'В отдельное окно' }).click({ force: true });
    // Development StrictMode disposes its first effect/window before mounting the real one.
    let popup: Page | undefined;
    await expect(async () => {
      popup = client.windows().find((p) => p !== page && !p.isClosed());
      expect(popup).toBeDefined();
      expect(await popup?.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(640);
    }).toPass();
    if (!popup) throw new Error('No popout');
    return popup;
  };
  const read = () => page.evaluate(async (path) => (await import(/* @vite-ignore */ path) as typeof import('../e2e-support/popout-stream')).state(), fixture);
  const navigate = (calendar: boolean) => page.evaluate(async ({ path, calendar }) => (await import(/* @vite-ignore */ path) as typeof import('../e2e-support/popout-stream')).navigate(calendar), { path: fixture, calendar });
  const popup = await open();
  await navigate(true);
  await expect(stage).toHaveCount(0);
  expect(popup.isClosed()).toBe(false);
  await expect(popup.locator('video')).toBeVisible();
  const child = await client.browserWindow(popup);
  await child.evaluate((w: BrowserWindow) => w.setContentSize(640, 400));
  await expect.poll(async () => (await read()).size).toEqual({ width: 640, height: 400 });
  await expect.poll(async () => (await read()).visible).toBe(true);
  expect(await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w: BrowserWindow) => w.webContents.getURL() === 'about:blank')?.isAlwaysOnTop())).toBe(true);
  if (process.platform === 'darwin') expect(await child.evaluate((w: BrowserWindow) => w.isVisibleOnAllWorkspaces())).toBe(true);
  await popup.screenshot({ path: testInfo.outputPath('popout.png') });
  await page.screenshot({ path: testInfo.outputPath('calendar-with-popout.png') });
  const main = await client.browserWindow(page);
  await main.evaluate((w: BrowserWindow) => w.minimize());
  await expect.poll(() => page.evaluate(() => document.hidden)).toBe(true);
  await expect.poll(async () => (await read()).visible).toBe(true);
  const frames = () => popup.locator('video').evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);
  const before = await frames();
  await expect.poll(frames).toBeGreaterThan(before);
  await child.evaluate((w: BrowserWindow) => w.minimize());
  await expect.poll(async () => (await read()).visible).toBe(false);
  await child.evaluate((w: BrowserWindow) => w.restore());
  await expect.poll(async () => (await read()).visible).toBe(true);
  await page.evaluate(async (path) => (await import(/* @vite-ignore */ path) as typeof import('../e2e-support/popout-stream')).replace(), fixture);
  await expect.poll(async () => (await read()).visible).toBe(true);
  await expect.poll(() => popup.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(640);
  await main.evaluate((w: BrowserWindow) => w.restore());
  await navigate(false);
  await expect(stage.locator('video')).toHaveCount(0);
  await stage.getByRole('button', { name: 'Вернуть сюда' }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect.poll(async () => (await read()).live).toBe(true);
  await expect.poll(() => stage.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(640);
  const closed = await open();
  await (await client.browserWindow(closed)).evaluate((w: BrowserWindow) => w.close());
  await expect.poll(async () => (await read()).stage).toBe('expanded');
  const stopped = await open();
  await page.evaluate(async (path) => (await import(/* @vite-ignore */ path) as typeof import('../e2e-support/popout-stream')).stop(), fixture);
  await expect.poll(() => stopped.isClosed()).toBe(true);
  expect((await read()).live).toBe(true);
});
