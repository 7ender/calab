import type { Page } from '@playwright/test';
import { expect, test } from './app';
import { checkpoint, settle } from './harness';

/**
 * Stream UX (docs/09 #17, #18): the source picker with one screen and my own stream on the stage.
 * Project `stream-dark-960` (playwright.visual.config.ts); run one screen with -g:
 *
 *   CALABA_VISUAL_MOCK_PORT=40070 MOCK_LIVEKIT_ROOM_PREFIX=str_ \
 *     pnpm -F @calaba/desktop e2e:visual -g "stream-picker-screen|voice-stream-self"
 */

test.describe.configure({ mode: 'parallel' });

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** «общий» at the bottom, then «Переговорка» (dev LiveKit), muted, signal bars steady. */
async function inVoice(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  await page.locator('aside').getByRole('button', { name: /Переговорка/ }).first().click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press(`${MOD}+Shift+m`);
  await expect(page.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
  await settle(page);
}

/** The picker with one synthetic screen: one large centred card, «Весь экран» selected. */
async function openPicker(page: Page, oneScreen: boolean): Promise<void> {
  await page.evaluate((one) => {
    (window as unknown as { __calabaVisualOneScreen?: boolean }).__calabaVisualOneScreen = one;
  }, oneScreen);
  await page.getByRole('button', { name: 'Показать экран' }).first().click();
  await expect(page.getByTestId('stream-source').first()).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Весь экран' })).toHaveAttribute('aria-checked', 'true');
}

test('stream-picker-screen', async ({ open, win, shot }) => {
  await open();
  await inVoice(win);
  await openPicker(win, true);
  const picker = win.getByTestId('stream-picker');
  await expect(picker.locator('[data-layout="single"]')).toBeVisible();
  await expect(picker.getByTestId('stream-source')).toHaveCount(1);
  // Sharp: the thumbnail is drawn at its natural size (fetched for this box × devicePixelRatio).
  const img = picker.getByTestId('stream-source').locator('img').first();
  await expect
    .poll(() =>
      img.evaluate((el: HTMLImageElement) => {
        const r = el.getBoundingClientRect();
        return Math.abs(el.naturalWidth / devicePixelRatio - r.width) <= 1;
      }),
    )
    .toBe(true);
  // The selected card's ring stays inside the card (inset).
  await expect(picker.getByTestId('stream-source').first()).toHaveCSS('box-shadow', /inset/);
  await checkpoint(shot, 'stream-picker-screen');
});

test('voice-stream-self', async ({ open, win, shot }) => {
  await open();
  await inVoice(win);
  await openPicker(win, true);
  await win.getByRole('button', { name: 'Начать стрим' }).click();
  // My own stream shows up like anyone's (docs/09 #18a): on the stage or in the PiP, «Вы стримите».
  const video = win.getByTestId('stream-stage').or(win.getByTestId('stream-pip'));
  await expect(video.first()).toBeVisible({ timeout: 30_000 });
  if ((await win.getByTestId('stream-stage').count()) === 0) {
    await win.getByTestId('stream-pip').getByRole('button', { name: 'Развернуть' }).first().click();
  }
  await expect(win.getByTestId('stream-stage')).toBeVisible();
  await expect(win.getByTestId('stream-stage').getByTestId('stream-self-badge')).toHaveText('Вы стримите');
  // The captured page (a synthetic source) changes every run: hide the pixels, keep the chrome.
  await win.addStyleTag({ content: 'video { visibility: hidden !important; }' });
  try {
    await checkpoint(shot, 'voice-stream-self');
    // «На весь экран»: the video-only layout (the window's native full screen is not photographed).
    await win.getByTestId('stream-controls').getByRole('button', { name: 'На весь экран' }).focus();
    await win.getByTestId('stream-controls').getByRole('button', { name: 'На весь экран' }).click();
    await expect(win.getByTestId('stream-fullscreen')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('stream-fullscreen')).toHaveCount(0);
  } finally {
    await win.getByRole('button', { name: 'Остановить стрим' }).first().click().catch(() => undefined);
  }
  await expect(win.getByTestId('stream-stage').or(win.getByTestId('stream-pip'))).toHaveCount(0, { timeout: 15_000 });
});
