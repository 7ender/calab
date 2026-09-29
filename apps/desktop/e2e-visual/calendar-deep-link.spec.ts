import { expect, planerka, signIn, test } from './calendarWeb';

/**
 * Deep link (docs/20 C.15): the web opened at /e/<id> without a session → the login screen → after
 * signing in the day of the meeting with its card; an unknown id → «Встреча не найдена».
 */
test('/e/<id> → sign in → the meeting card', async ({ page, mock }) => {
  const id = planerka(mock);
  await signIn(page, mock, `/e/${id}`);
  await expect(page.getByTestId('day-view')).toBeVisible();
  await expect(page.getByTestId('event-panel').getByTestId('event-title')).toHaveText('Планёрка');
  await expect(page.getByTestId('event-block').filter({ hasText: 'Планёрка' })).toHaveAttribute('aria-pressed', 'true');
  // The address bar no longer carries the link (a reload opens the app, not the link again).
  expect(new URL(page.url()).pathname).toBe('/');
});

test('/e/<unknown id> → «Встреча не найдена»', async ({ page, mock }) => {
  await signIn(page, mock, '/e/00000000-0000-7000-8000-00000000ffff');
  await expect(page.getByText('Встреча не найдена')).toBeVisible();
});
