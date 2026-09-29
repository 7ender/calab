import { AttendeeStatus } from '@calaba/protocol';
import { IDS } from '../e2e-support/mock-server';
import { expect, openDay, planerka, signIn, test } from './calendarWeb';

/**
 * RSVP from the app (docs/20 C.4): Анна answers «Приму», «Может быть», «Отклоню» on the card —
 * each is PUT /api/events/{id}/rsvp with that status, the pressed button follows, the counts too;
 * Борис's answer arrives as EVENT_RSVP and updates the card without a reload.
 */
test('the three answers, the counts, another attendee live', async ({ page, mock }) => {
  const id = planerka(mock);
  await signIn(page, mock);
  await openDay(page);
  await page.getByTestId('event-block').filter({ hasText: 'Планёрка' }).click();
  const card = page.getByTestId('event-panel');
  const rsvp = card.getByTestId('rsvp');
  const counts = card.getByTestId('event-counts');

  for (const [label, status] of [
    ['Приму', 'ATTENDEE_STATUS_ACCEPTED'],
    ['Может быть', 'ATTENDEE_STATUS_MAYBE'],
    ['Отклоню', 'ATTENDEE_STATUS_DECLINED'],
  ] as const) {
    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/api/events/${id}/rsvp`));
    await rsvp.getByRole('button', { name: label }).click();
    expect((await put).postDataJSON()).toEqual({ status });
    await expect(rsvp.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
  }
  // Борис (organizer) accepted; Анна declined; Вера and the external address wait.
  await expect(counts).toHaveText(/1.*1.*0.*2/);

  mock.rsvp(id, IDS.users.vera, AttendeeStatus.MAYBE);
  await expect(counts).toHaveText(/1.*1.*1.*1/);
  const vera = card.getByTestId('event-attendee').filter({ hasText: 'Вера' });
  await expect(vera.getByRole('img', { name: 'Может быть' })).toBeVisible();
  await expect(vera).toContainText('(необязательно)');
  await expect(card.getByTestId('event-attendee').filter({ hasText: 'ext@example.com' })).toBeVisible();
});
