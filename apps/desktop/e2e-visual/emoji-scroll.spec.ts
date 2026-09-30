import type { Locator, Page } from '@playwright/test';
import { expect, test } from './app';
import { settle } from './harness';

/**
 * docs/09 #118: the shared emoji picker's list scrolls with the wheel in every context — the
 * composer (a plain popover) and a sticker's emoji chip inside the workspace settings sheet (a
 * modal Radix dialog). Behaviour only, no screenshots.
 *
 *   pnpm -F @calaba/desktop e2e:visual --project emoji-scroll
 */

/** Wheels over the middle of the picker's list and expects its scrollTop to grow. */
async function expectWheelScrolls(page: Page, picker: Locator): Promise<void> {
  const list = picker.getByTestId('emoji-picker-list');
  await expect(list.locator('button[data-emoji]').first()).toBeVisible();
  const before = await list.evaluate((el) => ({ top: el.scrollTop, room: el.scrollHeight - el.clientHeight }));
  expect(before.room, 'the list has more than one screen of emoji').toBeGreaterThan(100);
  const box = await list.boundingBox();
  if (!box) throw new Error('no emoji list');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(before.top);
}

async function general(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  await expect(page.locator('[data-message-id]').first()).toBeVisible();
  await settle(page);
}

test('composer picker', async ({ open, win }) => {
  await open();
  await general(win);
  await win.getByRole('button', { name: 'Эмодзи' }).click();
  await expectWheelScrolls(win, win.getByTestId('emoji-picker'));
});

test('sticker emoji chip in settings', async ({ open, win }) => {
  await open();
  await general(win);
  await win.getByTestId('titlebar-title').click();
  await win.getByRole('menuitem', { name: 'Настройки пространства' }).click();
  const dialog = win.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Стикеры' }).click();
  await dialog.getByTestId('sticker-pack-row').filter({ hasText: 'Calab' }).click();
  const chip = dialog.getByTestId('sticker-cell').last().getByTestId('sticker-emoji');
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  await expectWheelScrolls(win, win.getByTestId('emoji-picker'));
});
