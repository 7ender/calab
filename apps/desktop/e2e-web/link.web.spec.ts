import { expect, test } from '@playwright/test';

/**
 * Web link page (docs/09 #53): `/join/<code>` shows the «Открыть в Calab» card before any web
 * flow; «Продолжить в браузере» leads to registration with the code (signed out). The app launch
 * itself is not fired here (it would hand `calab://` to the OS) — its states are covered by
 * e2e-visual/web.spec.ts and lib/appLaunch.test.ts.
 */
test('invite link: card → continue in the browser → registration with the code', async ({ page }) => {
  await page.goto('/join/e2e-link-card-0000');
  const card = page.getByTestId('link-landing');
  await expect(card.getByRole('heading', { name: 'Вас пригласили в пространство' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Открыть в Calab' })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Скачать приложение' })).toHaveAttribute('href', '/download/');
  await expect(card.getByRole('checkbox', { name: 'Всегда открывать в приложении' })).not.toBeChecked();
  expect(new URL(page.url()).pathname).toBe('/join/e2e-link-card-0000'); // kept while the card is shown

  await card.getByRole('button', { name: 'Продолжить в браузере' }).click();
  await expect(page.getByLabel('Код приглашения')).toHaveValue('e2e-link-card-0000');
  expect(new URL(page.url()).pathname).toBe('/');
});
