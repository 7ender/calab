import { expect, test, type Page } from '@playwright/test';

/**
 * Web onboarding, step «Уведомления» (docs/09 #20): `default` (not asked yet) offers «Включить
 * уведомления» and never the «Браузер запретил…» note; `granted` shows «Уведомления включены».
 * Runs against the mock (e2e-support, `--static dist-web`), signed out → login → onboarding.
 */
async function toNotificationsStep(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill('owner@calaba.test');
  await page.getByLabel('Пароль', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByTestId('onboarding-mic')).toBeVisible();
  await page.getByRole('button', { name: 'Позже' }).click();
  await expect(page.getByTestId('onboarding-mode')).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page.getByTestId('onboarding-notifications')).toBeVisible();
}

test('not asked yet: «Включить уведомления», no «denied» note', async ({ page }) => {
  await toNotificationsStep(page);
  expect(await page.evaluate(() => (globalThis as unknown as { Notification: { permission: string } }).Notification.permission)).toBe('default');
  const step = page.getByTestId('onboarding-notifications');
  await expect(step.getByRole('button', { name: 'Включить уведомления' })).toBeVisible();
  await expect(step.getByRole('button', { name: 'Позже' })).toBeVisible();
  await expect(step.getByText(/запретил/)).toHaveCount(0);
});

test('already granted: «Уведомления включены» and «Продолжить»', async ({ page, context, browserName }) => {
  test.skip(browserName === 'firefox', 'Playwright cannot grant notifications in Firefox');
  await context.grantPermissions(['notifications']);
  await toNotificationsStep(page);
  const step = page.getByTestId('onboarding-notifications');
  await expect(step.getByRole('status').filter({ hasText: 'Уведомления включены' })).toBeVisible();
  await expect(step.getByRole('button', { name: 'Продолжить' })).toBeVisible();
  await expect(step.getByRole('button', { name: 'Включить уведомления' })).toHaveCount(0);
});
