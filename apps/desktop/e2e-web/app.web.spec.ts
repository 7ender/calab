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
  // The shell (rail + its workspaces, rendered together after READY) must be up before the
  // non-waiting count() below, or a skipped onboarding would look like «no E2E workspace yet».
  await expect(page.getByRole('button', { name: 'Создать пространство' }).first()).toBeVisible();

  // Idempotent on a shared account (the stand limits workspace creation, 3/hour): reuse the
  // «E2E web» workspace and its rooms when they exist, create them only when missing.
  const rail = page.getByRole('navigation', { name: 'Пространства' });
  const existing = rail.getByRole('button', { name: /^E2E web\b/ });
  if ((await existing.count()) > 0) {
    await existing.first().click();
  } else {
    await page.getByRole('button', { name: 'Создать пространство' }).first().click();
    await page.getByLabel('Название').fill('E2E web');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
  }
  const rooms = page.locator('aside').first();
  await expect(rooms.getByRole('button', { name: 'Создать комнату' }).first()).toBeVisible();
  const general = rooms.getByRole('button', { name: /^общий(,|$)/ });
  if ((await general.count()) > 0) {
    await general.first().click();
  } else {
    await page.getByRole('button', { name: 'Создать комнату' }).first().click();
    await page.getByLabel('Название').fill('общий');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
  }

  const box = page.getByPlaceholder('Сообщение в #общий');
  await box.fill(`Привет из **веба** ${id}`);
  // Wait for the POST before reloading: a reload mid-request cancels it (API: 500 «context canceled»).
  const sent = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/rooms\/[^/]+\/messages$/.test(new URL(r.url()).pathname));
  await box.press('Enter');
  expect((await sent).ok()).toBe(true);
  await expect(page.getByText(id, { exact: false }).last()).toBeVisible();

  // The refresh token lives only in the HttpOnly cookie: JS must not see it, reload must keep us in.
  expect(String(await page.evaluate('document.cookie'))).not.toContain('calaba_refresh');
  const cookie = (await page.context().cookies()).find((c) => c.name === 'calaba_refresh');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'общий', exact: true })).toBeVisible();

  if (browserName === 'firefox' && process.env['CALABA_WEB_FF_VOICE'] !== '1') return;
  if ((await page.locator('aside button', { hasText: 'Созвон' }).count()) === 0) {
    await page.getByRole('button', { name: 'Создать комнату' }).nth(1).click();
    await page.getByLabel('Название').fill('Созвон');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
  }
  await page.locator('aside button', { hasText: 'Созвон' }).first().click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Отключиться' }).click();
  await expect(page.getByText('Голос подключён')).toHaveCount(0);
});
