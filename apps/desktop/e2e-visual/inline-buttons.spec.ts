import { IDS } from '../e2e-support/mock-server';
import { seedInlineButtons } from '../e2e-support/inline-buttons';
import { expect, signIn, test } from './calendarWeb';

test('inline buttons: pending, retry nonce, accepted and refreshed revision', async ({ page, mock }) => {
  const m = seedInlineButtons(mock);
  const bodies: { nonce: string; keyboardRevision: string; buttonId: string }[] = [];
  let release: (() => void) | undefined;
  await page.route(`**/api/messages/${m.id}/interactions`, async (route) => {
    bodies.push(route.request().postDataJSON() as { nonce: string; keyboardRevision: string; buttonId: string });
    if (bodies.length === 1) {
      await new Promise<void>((resolve) => { release = resolve; });
      await route.fulfill({ status: 503, json: { code: 'ERROR_CODE_UNAVAILABLE' } });
    } else {
      await route.fulfill({ status: 200, json: { interactionId: 'accepted' } });
    }
  });
  await signIn(page, mock);
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  const keyboard = page.getByTestId('inline-keyboard');
  await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(keyboard).toBeVisible();
  const confirm = keyboard.getByRole('button', { name: 'Подтвердить', exact: true });
  await confirm.click();
  await expect(confirm).toBeDisabled();
  await expect(keyboard.getByRole('status')).toHaveText('Отправляется боту…');
  expect(bodies).toHaveLength(1);
  release?.();
  await expect(keyboard.getByRole('status')).toHaveText('Не удалось отправить. Попробуйте снова.');
  await confirm.click();
  await expect(keyboard.getByRole('status')).toHaveText('Отправлено боту');
  await expect(confirm).toBeDisabled();
  await expect(keyboard.getByRole('button', { name: 'Изменить', exact: true })).toBeDisabled();
  expect(bodies[0]?.nonce).toBe(bodies[1]?.nonce);
  expect(bodies[0]).toEqual({ buttonId: 'confirm', keyboardRevision: '1', nonce: expect.any(String) });
  m.keyboardRevision = 2n;
  mock.dispatch({ event: { case: 'messageUpdate', value: { workspaceId: IDS.workspaces.main, message: m } } });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(keyboard.getByRole('status')).toHaveText('Отправлено боту');
  expect(bodies[2]?.nonce).not.toBe(bodies[0]?.nonce);
  expect(bodies[2]?.keyboardRevision).toBe('2');
  await expect(keyboard.getByRole('button', { name: 'Недоступно' })).toBeDisabled();
  m.inlineKeyboard = undefined;
  m.keyboardRevision = 3n;
  mock.dispatch({ event: { case: 'messageUpdate', value: { workspaceId: IDS.workspaces.main, message: m } } });
  await expect(keyboard).toHaveCount(0);
});


test('inline buttons: stale response refreshes draft without executing the replacement', async ({ page, mock }) => {
  const m = seedInlineButtons(mock);
  let presses = 0;
  await page.route(`**/api/messages/${m.id}/interactions`, async (route) => {
    presses++;
    await route.fulfill({ status: 409, json: { code: 'ERROR_CODE_CONFLICT', reason: 'KEYBOARD_STALE' } });
  });
  await page.route(`**/api/rooms/${m.roomId}/messages/${m.id}`, async (route) => {
    await route.fulfill({ status: 200, json: { id: m.id, roomId: m.roomId, authorId: m.authorId, content: 'Обновлённый черновик', keyboardRevision: '2', inlineKeyboard: { rows: [{ buttons: [{ id: 'confirm', label: 'Подтвердить новый' }] }] } } });
  });
  await signIn(page, mock);
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.locator(`[data-message-id="${m.id}"]`)).toContainText('Обновлённый черновик');
  await expect(page.getByRole('button', { name: 'Подтвердить новый' })).toBeEnabled();
  expect(presses).toBe(1);
});


for (const change of ['update', 'delete'] as const) {
  test(`inline buttons: delayed refresh respects newer ${change} event`, async ({ page, mock }) => {
    const m = seedInlineButtons(mock);
    let release: (() => void) | undefined;
    const url = `**/api/rooms/${m.roomId}/messages/${m.id}`;
    await page.route(`**/api/messages/${m.id}/interactions`, (route) => route.fulfill({ status: 409, json: { code: 'ERROR_CODE_CONFLICT', reason: 'KEYBOARD_STALE' } }));
    await page.route(url, async (route) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await route.fulfill({ status: 200, json: { id: m.id, roomId: m.roomId, authorId: m.authorId, content: 'Late stale draft', keyboardRevision: '2' } });
    });
    await signIn(page, mock);
    await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
    await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
    await expect.poll(() => !!release).toBe(true);
    const row = page.locator(`[data-message-id="${m.id}"]`);
    if (change === 'update') {
      m.content = 'Latest draft'; m.keyboardRevision = 3n;
      mock.dispatch({ event: { case: 'messageUpdate', value: { workspaceId: IDS.workspaces.main, message: m } } });
      await expect(row).toContainText('Latest draft');
    } else {
      mock.dispatch({ event: { case: 'messageDelete', value: { workspaceId: IDS.workspaces.main, roomId: m.roomId, messageId: m.id } } });
      await expect(row).toHaveCount(0);
    }
    const refreshed = page.waitForResponse((response) => response.url().endsWith(`/rooms/${m.roomId}/messages/${m.id}`));
    release?.();
    await refreshed;
    if (change === 'update') await expect(row).toContainText('Latest draft');
    else await expect(row).toHaveCount(0);
    await expect(page.getByText('Late stale draft')).toHaveCount(0);
  });
}
