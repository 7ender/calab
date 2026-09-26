import { expect, test } from '@playwright/test';

/**
 * Web client main scenario: register → workspace → room → message → reload keeps the
 * session (HttpOnly refresh cookie) → voice. Voice in Firefox is opt-in
 * (CALABA_WEB_FF_VOICE=1): against a Docker-hosted LiveKit on 127.0.0.1 Firefox's ICE
 * does not connect; on the stand it should.
 */
test('register → workspace → room → message → reload → voice', async ({ page, browserName }) => {
  const id = `${browserName}-${Date.now().toString(36)}`;
  await page.goto('/');
  // Invite-only servers (the stand): CALABA_WEB_LOGIN + CALABA_WEB_PASSWORD sign in with an
  // existing account (preferred — doesn't spend invite uses); otherwise register, with
  // CALABA_WEB_INVITE as the invite code when set.
  const login = process.env['CALABA_WEB_LOGIN'];
  const password = process.env['CALABA_WEB_PASSWORD'];
  if (login && password) {
    await page.getByLabel('Email').fill(login);
    await page.getByLabel('Пароль').fill(password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await page.getByLabel('Email').fill(`web-${id}@example.com`);
    await page.getByLabel('Имя').fill(`Web ${id}`);
    await page.getByLabel('Пароль').fill('password-web-123');
    const invite = process.env['CALABA_WEB_INVITE'];
    if (invite) await page.getByLabel('Код приглашения').fill(invite);
    await page.getByRole('button', { name: 'Зарегистрироваться' }).last().click();
  }
  // First run: onboarding (docs/08) — skip it, it has its own visual tests. (Builds from
  // before the onboarding go straight to the main window.)
  const skip = page.getByRole('button', { name: 'Пропустить настройку' });
  await expect(skip.or(page.getByRole('button', { name: 'Создать пространство' }).first())).toBeVisible({ timeout: 20_000 });
  if (await skip.isVisible()) await skip.click();

  await page.getByRole('button', { name: 'Создать пространство' }).first().click();
  await page.getByLabel('Название').fill(`Web ${id}`);
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.getByRole('button', { name: 'Создать комнату' }).first().click();
  await page.getByLabel('Название').fill('общий');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();

  const box = page.getByPlaceholder('Сообщение в #общий');
  await box.fill('Привет из **веба**');
  await box.press('Enter');
  await expect(page.locator('strong', { hasText: 'веба' })).toBeVisible();

  // The refresh token lives only in the HttpOnly cookie: JS must not see it, reload must keep us in.
  expect(String(await page.evaluate('document.cookie'))).not.toContain('calaba_refresh');
  const cookie = (await page.context().cookies()).find((c) => c.name === 'calaba_refresh');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();

  if (browserName === 'firefox' && process.env['CALABA_WEB_FF_VOICE'] !== '1') return;
  await page.getByRole('button', { name: 'Создать комнату' }).nth(1).click();
  await page.getByLabel('Название').fill('Созвон');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.locator('aside button', { hasText: 'Созвон' }).click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Отключиться' }).click();
  await expect(page.getByText('Голос подключён')).toHaveCount(0);
});
