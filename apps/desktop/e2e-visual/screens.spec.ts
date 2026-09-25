import { expect, test, type Page } from '@playwright/test';
import { IDS } from '../e2e-support/mock-server';
import { THEMES, VIEWPORTS, checkpoint, launch, login, type Env, type Shot } from './harness';
import { startPublisher } from './publisher';

/**
 * Visual regression of every main screen (docs/08, «Тесты дизайна»): dark + light, 960 and
 * 1440 px wide. Each checkpoint = screenshot (≤ 0.2 % differing pixels) + layout invariants +
 * axe (0 serious/critical). Update the baseline: `pnpm e2e:visual:update`.
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Settings windows: photograph every section (left list = role «tab»). */
async function everyTab(s: Shot, prefix: string): Promise<void> {
  const dialog = s.page.getByRole('dialog');
  const tabs = dialog.getByRole('tab');
  const n = await tabs.count();
  for (let i = 0; i < n; i++) {
    const tab = tabs.nth(i);
    await tab.click();
    await expect(tab).toHaveAttribute('data-state', 'active');
    await checkpoint(s, `${prefix}-${i + 1}`, { mask: [s.page.getByTestId('mic-meter')] });
  }
}

async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test.describe(`${theme} ${viewport.width}`, () => {
      let env: Env | undefined;
      // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures argument
      test.afterEach(async ({}, info) => {
        if (env && info.status !== info.expectedStatus) {
          // Electron pages are not covered by Playwright's `screenshot` option.
          await info.attach('failure', { body: await env.page.screenshot().catch(() => Buffer.alloc(0)), contentType: 'image/png' });
        }
        await env?.close();
      });

      test('auth → onboarding → app screens', async () => {
        env = await launch({ theme, viewport });
        const { page, mock } = env;
        const s: Shot = { page, theme, viewport };

        // ---- auth
        await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
        await checkpoint(s, 'auth-login');
        await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
        await expect(page.getByLabel('Имя')).toBeVisible();
        await checkpoint(s, 'auth-register');
        await page.getByRole('button', { name: 'Войти', exact: true }).last().click();
        await login(page);

        // ---- onboarding (the fixed OS statuses come from CALABA_VISUAL_TEST)
        await expect(page.getByTestId('onboarding-mic')).toBeVisible();
        await checkpoint(s, 'onboarding-mic');
        await page.getByRole('button', { name: 'Разрешить микрофон' }).click();
        await expect(page.getByTestId('mic-meter')).toBeVisible();
        await checkpoint(s, 'onboarding-mic-ok', { mask: [page.getByTestId('mic-meter')] });
        await page.getByRole('button', { name: 'Слышно хорошо' }).click();
        await expect(page.getByTestId('onboarding-mode')).toBeVisible();
        await checkpoint(s, 'onboarding-mode');
        await page.getByRole('radio', { name: 'Push-to-talk' }).click();
        await checkpoint(s, 'onboarding-mode-ptt');
        await page.getByRole('radio', { name: 'Активация голосом' }).click();
        await page.getByRole('button', { name: 'Дальше' }).click();
        if (process.platform === 'darwin') {
          await expect(page.getByTestId('onboarding-screen')).toBeVisible();
          await checkpoint(s, 'onboarding-screen');
          await page.getByRole('button', { name: 'Позже' }).click();
        }
        await expect(page.getByTestId('onboarding-notifications')).toBeVisible();
        await checkpoint(s, 'onboarding-notifications');
        await page.getByRole('button', { name: 'Позже' }).click();
        await expect(page.getByTestId('onboarding-done')).toBeVisible();
        await checkpoint(s, 'onboarding-done');
        await page.getByRole('button', { name: 'Начать' }).click();

        // ---- main window with data
        await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
        await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
        mock.injectMessage({ roomId: IDS.rooms.dev, authorId: IDS.users.boris, content: '@АннаСмирнова глянь, пожалуйста, ревью' });
        await expect(page.getByRole('navigation').or(page.locator('aside')).getByText('1', { exact: true }).first()).toBeVisible();
        await checkpoint(s, 'main-chat');

        // Members: a column from 1200 px (open by default), a floating panel below (closed by default).
        await page.getByRole('button', { name: 'Участники' }).click();
        await checkpoint(s, 'main-members-toggled');
        await page.getByRole('button', { name: 'Участники' }).click();

        // ---- quick switcher
        await page.keyboard.press(`${MOD}+k`);
        await expect(page.getByRole('dialog')).toBeVisible();
        await checkpoint(s, 'quick-switcher');
        await page.keyboard.type('раз');
        await checkpoint(s, 'quick-switcher-filtered');
        await closeDialog(page);

        // ---- workspace menu + settings
        await page.locator('aside').getByRole('button', { name: /Команда Calaba/ }).click();
        await expect(page.getByRole('menu')).toBeVisible();
        await checkpoint(s, 'workspace-menu');
        await page.getByRole('menuitem', { name: 'Настройки пространства' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await everyTab(s, 'workspace-settings');
        await closeDialog(page);

        // ---- room create + room settings + destructive confirm
        await page.getByRole('button', { name: 'Создать комнату' }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await checkpoint(s, 'room-create');
        await closeDialog(page);

        await page.getByRole('button', { name: 'Настройки комнаты' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await everyTab(s, 'room-settings');
        await page.getByRole('dialog').getByRole('tab').first().click();
        await page.getByRole('button', { name: 'Удалить…' }).click();
        await expect(page.getByRole('alertdialog').or(page.getByRole('dialog').last())).toBeVisible();
        await checkpoint(s, 'confirm-delete-room');
        await page.getByRole('button', { name: 'Отмена' }).click();
        await closeDialog(page);

        // ---- app settings (every section)
        await page.getByRole('button', { name: 'Настройки', exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await everyTab(s, 'settings');
        await closeDialog(page);

        // ---- voice room + stream (needs the dev LiveKit)
        await page.locator('aside').getByRole('button', { name: /Переговорка/ }).first().click();
        await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
        await page.keyboard.press(`${MOD}+Shift+m`); // muted: the fake mic beeps → speaking rings would flicker
        await expect(page.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
        // LiveKit creates the room on the first join, so the publisher comes second.
        const publisher = await startPublisher({ userId: IDS.users.vera, name: 'Вера Ким', roomId: IDS.rooms.meeting });
        try {
          const video = page.locator('video');
          const chip = page.getByRole('button', { name: 'Вера Ким', exact: true });
          await expect(video.or(chip).first()).toBeVisible({ timeout: 30_000 });
          if ((await video.count()) === 0) await chip.first().click();
          await expect(video.first()).toBeVisible();
          const dynamic = [video, page.getByRole('button', { name: /^Качество связи/ })];
          // Default stage while chatting: PiP in the corner, clear of the composer.
          await expect(page.getByTestId('stream-pip')).toBeVisible();
          await checkpoint(s, 'voice-pip', { mask: dynamic });
          await page.getByTestId('stream-pip').getByRole('button', { name: 'Развернуть' }).first().click();
          await expect(page.getByTestId('stream-pip')).toHaveCount(0);
          await checkpoint(s, 'voice-stream', { mask: dynamic });
          await page.getByRole('button', { name: 'Настройки комнаты' }).click();
          await expect(page.getByRole('dialog')).toBeVisible();
          await everyTab(s, 'voice-room-settings');
          await closeDialog(page);
          await page.getByRole('button', { name: 'Отключиться' }).click();
        } finally {
          await publisher.stop();
        }
      });

      test('first run without workspaces', async () => {
        env = await launch({ theme, viewport, scenario: 'empty', onboarded: true });
        await login(env.page);
        await expect(env.page.getByRole('button', { name: 'Создать пространство' }).first()).toBeVisible();
        const s: Shot = { page: env.page, theme, viewport };
        await checkpoint(s, 'welcome');
        await env.page.getByRole('button', { name: 'Создать пространство' }).first().click();
        await expect(env.page.getByRole('dialog')).toBeVisible();
        await checkpoint(s, 'workspace-create');
        await closeDialog(env.page);
        await env.page.getByRole('button', { name: 'Присоединиться' }).first().click();
        await expect(env.page.getByRole('dialog')).toBeVisible();
        await checkpoint(s, 'workspace-join');
        await closeDialog(env.page);
      });
    });
  }
}
