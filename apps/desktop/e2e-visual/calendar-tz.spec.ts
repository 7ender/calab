import { expect, openDay, planerka, signIn, test } from './calendarWeb';

/**
 * Time zones (docs/20 C.12): one meeting at 12:00 UTC reads 15:00 for Анна in Moscow (+3) and
 * 19:00 for Борис in Krasnoyarsk (+7) — two browser contexts with their own `timezoneId`.
 */
test('the same meeting on each viewer’s own clock', async ({ browser, mock }) => {
  planerka(mock);
  const moscow = await browser.newContext({ timezoneId: 'Europe/Moscow', locale: 'ru-RU', viewport: { width: 1280, height: 800 } });
  const krasnoyarsk = await browser.newContext({ timezoneId: 'Asia/Krasnoyarsk', locale: 'ru-RU', viewport: { width: 1280, height: 800 } });
  try {
    const a = await moscow.newPage();
    const b = await krasnoyarsk.newPage();
    await signIn(a, mock);
    await signIn(b, mock, '/', 'boris@calaba.test');
    await openDay(a);
    await openDay(b);
    await expect(a.getByTestId('event-block').filter({ hasText: 'Планёрка' })).toContainText('15:00 – 16:00');
    await expect(b.getByTestId('event-block').filter({ hasText: 'Планёрка' })).toContainText('19:00 – 20:00');
    await b.getByTestId('event-block').filter({ hasText: 'Планёрка' }).click();
    await expect(b.getByTestId('event-when')).toHaveText('Четверг, 15 января · 19:00 – 20:00');
    // The dialog says whose clock its times are on.
    await b.getByTestId('event-edit').click();
    await expect(b.getByTestId('event-dialog')).toContainText('Asia/Krasnoyarsk');
  } finally {
    await moscow.close();
    await krasnoyarsk.close();
  }
});
