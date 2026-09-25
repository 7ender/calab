import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Main scenario (TESTING.md "Desktop app"): register → create workspace → text room →
 * send a message → create a voice room and join it. Needs a running API server with
 * REGISTRATION_MODE=open and LiveKit configured.
 */
const SERVER = process.env['CALABA_E2E_SERVER_URL'];
test.skip(!SERVER, 'set CALABA_E2E_SERVER_URL to run E2E');

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      CALABA_SERVER_URL: SERVER ?? '',
      CALABA_USER_DATA: mkdtempSync(join(tmpdir(), 'calaba-e2e-')),
      CALABA_MULTI_INSTANCE: '1',
      CALABA_FAKE_MEDIA: '1', // synthetic mic, no OS permission prompts
      ELECTRON_RENDERER_URL: '', // always the production renderer from out/
    },
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
});

test('register → workspace → room → message → voice', async () => {
  const id = Date.now().toString(36);
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await page.getByLabel('Email').fill(`e2e-${id}@example.com`);
  await page.getByLabel('Имя').fill(`E2E ${id}`);
  await page.getByLabel('Пароль').fill('password-e2e-123');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).last().click();
  // First run: onboarding (docs/08) — skip it, it has its own visual tests.
  await page.getByRole('button', { name: 'Пропустить настройку' }).click();

  // Welcome screen → create a workspace.
  await page.getByRole('button', { name: 'Создать пространство' }).first().click();
  await page.getByLabel('Название').fill(`E2E ${id}`);
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(page.getByText('Текстовые комнаты', { exact: false })).toBeVisible();

  // Text room.
  await page.getByRole('button', { name: 'Создать комнату' }).first().click();
  await page.getByLabel('Название').fill('общий');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();

  // Message with markdown; it must survive the optimistic → server round trip.
  const box = page.getByPlaceholder('Написать в #общий');
  await box.fill('Привет из **E2E**');
  await box.press('Enter');
  const msg = page.locator('strong', { hasText: 'E2E' });
  await expect(msg).toBeVisible();
  await expect(page.getByText('Не отправлено')).toHaveCount(0);

  // Voice room: create and join.
  await page.getByRole('button', { name: 'Создать комнату' }).nth(1).click();
  await page.getByLabel('Название').fill('Созвон');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.locator('aside button', { hasText: 'Созвон' }).click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Отключиться' }).click();
  await expect(page.getByText('Голос подключён')).toHaveCount(0);
});
