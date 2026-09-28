import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RecordingStatus } from '@calaba/protocol';
import type { Locator, Page } from '@playwright/test';
import { IDS, type MockServer } from '../e2e-support/mock-server';
import { expect, test } from '../e2e-visual/app';
import { settle } from '../e2e-visual/harness';

/**
 * Landing feature rows (apps/landing, docs/09 #97): the mock-driven renderer (out/, like the
 * visual tests — no packaged app), captured at the display's scale (2x on a Retina Mac) into
 * docs/images/<name>-<theme>@2x.png; `pnpm -F @calaba/landing assets` crops them to webp.
 *   pnpm build:app && CALABA_VISUAL_MOCK_PORT=39370 MOCK_LIVEKIT_ROOM_PREFIX=landing_ \
 *     pnpm screenshots:marketing -g landing        (dark; CALABA_LANDING_THEME=light for light)
 * Needs the dev LiveKit (pnpm infra:dev) for the voice and call shots.
 * Shots: voice (in a room, Борис speaking, the noise popover), call (a one-to-one call in the DM),
 * recording (a done meeting card with the summary, playing), stickers (sticker messages + the panel).
 */
const OUT = resolve(import.meta.dirname, '../../../docs/images');
const SIZE = { width: 1280, height: 800 };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function capture(page: Page, name: string, theme: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}-${theme}@2x.png`), scale: 'device', animations: 'disabled', caret: 'hide' });
}

async function general(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  await expect(page.locator('[data-message-id]').first()).toBeVisible();
  await settle(page);
}

async function feedBottom(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await settle(page);
  }
}

async function inVoice(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: /Переговорка/ }).first().click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press(`${MOD}+Shift+m`);
  await expect(page.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
}

async function doneCard(page: Page, mock: MockServer): Promise<Locator> {
  mock.injectMessage({ roomId: IDS.rooms.meeting, authorId: IDS.users.boris, content: 'Спасибо всем, запись будет в чате' });
  mock.injectRecordingCard({ roomId: IDS.rooms.meeting, byUserId: IDS.users.boris, durationSec: 42 * 60 + 10, status: RecordingStatus.DONE, result: true });
  const sidebar = page.locator('aside').first();
  await sidebar.getByRole('button', { name: /^Переговорка/ }).first().hover();
  await sidebar.getByRole('button', { name: 'Чат комнаты «Переговорка»' }).click();
  await expect(page.getByRole('heading', { name: 'Переговорка' })).toBeVisible();
  const card = page.getByTestId('recording-card');
  await expect(card).toHaveCount(1);
  return card;
}

// Worker-scoped options can't change per describe: one theme per run (CALABA_LANDING_THEME).
const theme = process.env['CALABA_LANDING_THEME'] === 'light' ? 'light' : 'dark';
test.use({ theme, size: SIZE });


test(`landing voice ${theme}`, async ({ open, win, mock }) => {
  await open();
  await general(win);
  await inVoice(win);
  mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.meeting, muted: false });
  await win.evaluate((id) => (window as unknown as { __calabaSpeaking?: (ids: string[]) => void }).__calabaSpeaking?.([id]), IDS.users.boris);
  await win.evaluate(() => (window as unknown as { __calabaJoinedAt?: (ms: number) => void }).__calabaJoinedAt?.(Date.now() - 60_000));
  await win.getByTestId('noise-button').click();
  const toggle = win.getByTestId('noise-popover').getByRole('switch', { name: 'Шумоподавление' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await win.mouse.move(0, 0);
  await capture(win, 'landing-voice', theme);
});

test(`landing call ${theme}`, async ({ open, win, mock }) => {
  await open({ ui: { activeWorkspaceId: '@me' } });
  const list = win.getByTestId('dm-list');
  await expect(list.getByRole('button')).toHaveCount(3);
  await expect(list).toContainText('Да, подготовлю пару слайдов');
  await list.getByRole('button', { name: /Борис Петров/ }).click();
  await expect(win.getByTestId('dm-header')).toContainText('Борис Петров');
  await expect(win.locator('[data-message-id]')).toHaveCount(4);
  mock.ringCall(IDS.users.boris, IDS.users.anna);
  await win.getByTestId('call-accept').click();
  await expect(win.getByTestId('dm-call-active')).toBeVisible();
  await expect(win.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await win.keyboard.press(`${MOD}+Shift+m`);
  await expect(win.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
  await feedBottom(win);
  await capture(win, 'landing-call', theme);
  await win.getByTestId('dm-call-hangup').click();
});

test(`landing recording ${theme}`, async ({ open, win, mock }) => {
  await open();
  await general(win);
  const card = await doneCard(win, mock);
  await expect(card.getByTestId('recording-card-summary')).toContainText('Релиз 0.7');
  await feedBottom(win);
  await win.mouse.move(0, 0);
  await capture(win, 'landing-recording', theme);
});
