import type { Page } from '@playwright/test';
import { IDS } from '../e2e-support/mock-server';
import { expect, test } from './app';
import { NOW, settle } from './harness';

/**
 * docs/09 #120: «Поздравить» on the members-panel birthday plate opens the greeting room (the
 * first text room — «общий», where the server posts the card), scrolls to today's card if it is
 * there and puts `@Имя ` in the composer with focus (nothing is sent). Behaviour only, no
 * screenshots.
 *
 *   pnpm -F @calaba/desktop e2e:visual --project birthday-congratulate
 */

/** «общий» is loaded first (the card lands in its feed), then «разработка» is the open room. */
async function openDev(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  await page.locator('aside').getByRole('button', { name: /разработка/ }).first().click();
  await expect(page.getByRole('heading', { name: 'разработка' })).toBeVisible();
  await settle(page);
}

async function congratulate(page: Page): Promise<void> {
  const members = page.getByRole('complementary', { name: 'Участники' });
  if (!(await members.isVisible())) await page.getByRole('button', { name: 'Участники' }).click();
  await members.getByTestId('members-birthday-congratulate').click();
}

test('card posted: the greeting room, the card on screen, a ready mention', async ({ open, win, mock }) => {
  await open();
  // The page clock (13:30 MSK, 15 January) for the mock's «today» too: past 09:00 of Борис's zone.
  mock.setClock(NOW.getTime());
  await openDev(win);
  mock.setBirthday(IDS.users.boris, { day: 15, month: 1, year: 1990 }, { roomId: IDS.rooms.general });
  await congratulate(win);
  await expect(win.getByRole('heading', { name: 'общий' })).toBeVisible();
  const composer = win.getByPlaceholder('Сообщение в #общий');
  await expect(composer).toHaveValue('@Борис Петров ');
  await expect(composer).toBeFocused();
  await expect(win.getByTestId('birthday-card')).toBeInViewport();
  // No auto-send: no message of mine with the mention.
  await expect(win.getByTestId('message-bubble').filter({ hasText: '@Борис Петров' })).toHaveCount(0);
});

test('card not posted yet: the greeting room and the mention only', async ({ open, win, mock }) => {
  await open();
  // 06:30 MSK = 08:30 in Борис's Yekaterinburg: the card comes at 09:00 there.
  const morning = new Date('2026-01-15T06:30:00+03:00');
  await win.clock.setFixedTime(morning);
  mock.setClock(morning.getTime());
  await openDev(win);
  mock.setBirthday(IDS.users.boris, { day: 15, month: 1, year: 1990 });
  await congratulate(win);
  await expect(win.getByRole('heading', { name: 'общий' })).toBeVisible();
  const composer = win.getByPlaceholder('Сообщение в #общий');
  await expect(composer).toHaveValue('@Борис Петров ');
  await expect(composer).toBeFocused();
  await expect(win.getByTestId('birthday-card')).toHaveCount(0);
});
