import type { Locator, Page } from '@playwright/test';
import { IDS, type MockServer } from '../e2e-support/mock-server';
import { expect, test } from './app';
import { checkpoint, settle } from './harness';
import { startPublisher } from './publisher';

/**
 * Visual regression of the main screens (docs/08, «Тесты дизайна»): one Playwright project per
 * configuration (playwright.visual.config.ts). Every test is one screen, named like its snapshot,
 * and starts from a clean seeded state (app.ts):
 *
 *   pnpm -F @calaba/desktop e2e:visual -g "voice-camera-grid"                 # dark-960 (local)
 *   CALABA_VISUAL_ALL=1 pnpm -F @calaba/desktop e2e:visual -g "voice-camera-grid" --project light-1440
 *
 * Locally (owner, 26.09) only the KEY screens below run, in dark-960 only; every other screen
 * (each settings tab, every menu variant, toasts…) and the other configurations run only with
 * CALABA_VISUAL_ALL=1 — the nightly CI on Linux. Their code stays here, skipped locally.
 *
 * Each checkpoint = screenshot (≤ 0.2 % differing pixels) + layout invariants + axe (0
 * serious/critical). Update: `pnpm e2e:visual:update -g "<screen>"`.
 */

/** The full matrix: every screen, every configuration (nightly CI). */
const ALL = process.env['CALABA_VISUAL_ALL'] === '1';

/**
 * The local set (~25): one shot per screen family, no per-menu-item or per-tab shots. Settings:
 * 2 = «Голос и устройства», 3 = «Горячие клавиши», 8 = «Приложение» (language).
 */
const KEY = new Set([
  'auth-login',
  'onboarding-mic',
  'onboarding-screen',
  'onboarding-done',
  'onboarding-layout',
  'welcome',
  'main-chat',
  'sidebar-drag',
  'chat-hover-actions',
  'chat-context-menu',
  'dm-list',
  'dm-chat',
  'voice-room-status',
  'voice-room-speaking',
  'voice-room-pending',
  'voice-stream',
  'voice-pip',
  'voice-camera-grid',
  'voice-camera-pip',
  'voice-noise-popover',
  'main-members-toggled',
  'members-menu',
  'profile-dialog',
  'workspace-menu',
  'quick-switcher',
  'settings-2',
  'settings-3',
  'settings-8',
  'room-settings-1',
  'i18n-en-main-chat',
]);

// Non-key screens: skipped unless CALABA_VISUAL_ALL=1 (before any fixture, so no app launch).
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(!ALL && !KEY.has(info.title), 'full matrix only (CALABA_VISUAL_ALL=1, nightly CI)');
});

test.describe.configure({ mode: 'parallel' });

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// ---------------------------------------------------------------- helpers

/** Keyboard focus (matches :focus-visible, unlike a bare focus() after a click). */
async function keyboardFocus(target: Locator): Promise<void> {
  await target.focus();
  await target.page().keyboard.press('Tab');
  await target.page().keyboard.press('Shift+Tab');
  await expect(target).toBeFocused();
}

/**
 * The main window as every main-window screen shows it: «общий» open and scrolled to the
 * bottom, a live @-mention in «разработка» (badge 2).
 */
async function mainWindow(page: Page, mock: MockServer): Promise<void> {
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  mock.injectMessage({ roomId: IDS.rooms.dev, authorId: IDS.users.boris, content: `@${IDS.users.anna} глянь, пожалуйста, ревью` });
  // Mention badge on «разработка»: 1 from the history loaded at startup + this live one.
  await expect(page.locator('aside').first().getByText('2', { exact: true })).toBeVisible();
  // The room opens at the first unread; that anchor lands ±1 px apart between runs
  // (fractional row heights). Photograph the feed at its bottom, which is exact — only after
  // the history is in and the app placed the first-unread anchor.
  await expect(page.locator('[data-message-id]').first()).toBeVisible();
  await settle(page);
  await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  // Rows below the fold (link preview images) are measured after the scroll: let the feed settle
  // before any focus step scrolls it again (960 px shots came out at different offsets).
  await page.waitForFunction(() => [...document.querySelectorAll('[data-virtuoso-scroller] img')].every((i) => (i as HTMLImageElement).complete));
  await settle(page);
  await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await settle(page);
}

/** Members list visible (a column from 1200 px, a floating panel below). */
async function membersList(page: Page): Promise<Locator> {
  const members = page.getByRole('complementary', { name: 'Участники' });
  if (!(await members.isVisible())) await page.getByRole('button', { name: 'Участники' }).click();
  return members;
}

async function openSettingsTab(page: Page, opener: () => Promise<void>, index: number): Promise<void> {
  await opener();
  await expect(page.getByRole('dialog')).toBeVisible();
  const tab = page.getByRole('dialog').getByRole('tab').nth(index - 1);
  await tab.click();
  await expect(tab).toHaveAttribute('data-state', 'active');
}

/** In «Переговорка» (dev LiveKit), muted (the fake mic beeps), signal bars steady «good». */
async function inVoice(page: Page, mock: MockServer): Promise<void> {
  await mainWindow(page, mock);
  await page.locator('aside').getByRole('button', { name: /Переговорка/ }).first().click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press(`${MOD}+Shift+m`);
  await expect(page.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
  // Signal bars stay in the shots (docs/08: quality always visible): wait for the loopback
  // LiveKit's steady «good» instead of masking the indicator.
  await expect(page.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
}

const STATUS = 'Планёрка по релизу 0.2';

/** «Задать статус комнаты ✎» → the inline field (docs/09 #48); `save` = Enter (focus back on the row). */
async function editRoomStatus(page: Page, save: boolean): Promise<Locator> {
  const sidebar = page.locator('aside').first();
  const statusRow = sidebar.getByTestId('voice-status-row');
  await expect(statusRow).toContainText('Задать статус комнаты');
  await expect(sidebar.getByTestId('voice-invite-row')).toBeVisible();
  await statusRow.click();
  const statusInput = sidebar.getByTestId('voice-status-input');
  await expect(statusInput).toBeFocused();
  await statusInput.fill(STATUS);
  if (save) {
    await statusInput.press('Enter');
    await expect(statusRow).toContainText(STATUS);
    await expect(statusRow).toBeFocused(); // keyboard close returns focus to the row
    // The shots show the room as everyone sees it: no focus ring on the status line.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  }
  return statusRow;
}

/** In voice with the room status set, nothing focused (the state every later voice screen has). */
async function inVoiceWithStatus(page: Page, mock: MockServer): Promise<void> {
  await inVoice(page, mock);
  await editRoomStatus(page, true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Camera pixels (Chromium's fake device) change every run: hidden, the tile chrome stays. */
async function hideCameraPixels(page: Page): Promise<void> {
  await page.addStyleTag({ content: '[data-testid="camera-video"], [data-testid="camera-preview"] video { visibility: hidden !important; }' });
}

/** My camera on through the first-start sheet «Проверьте камеру». */
async function cameraOn(page: Page): Promise<void> {
  await page.getByTestId('camera-button').click();
  await expect(page.getByTestId('camera-preview-enable')).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId('camera-preview-enable').click();
  await expect(page.getByTestId('camera-button')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
}

type Publisher = Awaited<ReturnType<typeof startPublisher>>;

/**
 * My camera on + Борис's camera (a LiveKit camera track + VoiceState.camera, as the server
 * would), the PiP showing Борис. Returns the publisher to stop.
 */
async function withBorisCamera(page: Page, mock: MockServer): Promise<Publisher> {
  await inVoiceWithStatus(page, mock);
  await hideCameraPixels(page);
  await cameraOn(page);
  await expect(page.getByTestId('camera-pip')).toHaveAccessibleName('Камера: Анна Смирнова');
  const pub = await startPublisher({ userId: IDS.users.boris, name: 'Борис Петров', roomId: IDS.rooms.meeting, source: 'camera' });
  mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.meeting, muted: true, camera: true });
  // The PiP prefers a remote camera over the self-view.
  await expect(page.getByTestId('camera-pip')).toHaveAccessibleName('Камера: Борис Петров', { timeout: 30_000 });
  await expectFrames(page, 1);
  return pub;
}

/** The camera grid with 3 tiles (two cameras + Вера's avatar tile), Борис large. */
async function cameraGrid(page: Page): Promise<void> {
  await page.getByTestId('camera-pip').getByRole('button', { name: 'Развернуть видео' }).first().click();
  await expect(page.getByTestId('video-grid')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Камера: Борис Петров' })).toBeVisible({ timeout: 30_000 });
  await expectFrames(page, 2);
  await expect(page.getByTestId('video-tile')).toHaveCount(3);
  // My own camera is never the large tile by default: Борис's is.
  await expect(page.locator('[data-testid="video-tile"][data-featured]')).toHaveAccessibleName('Камера: Борис Петров');
}

/**
 * Вера streams into the voice room with my camera on (the stream is the main picture, my camera
 * in the strip). Empty voice-room chat (docs/09 #56): the stream opens expanded.
 */
async function withStream(page: Page, mock: MockServer): Promise<Publisher> {
  await inVoiceWithStatus(page, mock);
  await hideCameraPixels(page);
  await cameraOn(page);
  // LiveKit creates the room on the first join, so the publisher comes second.
  const pub = await startPublisher({ userId: IDS.users.vera, name: 'Вера Ким', roomId: IDS.rooms.meeting });
  const video = page.getByTestId('stream-stage').or(page.getByTestId('stream-pip'));
  const chip = page.getByRole('button', { name: 'Вера Ким', exact: true });
  await expect(video.or(chip).first()).toBeVisible({ timeout: 30_000 });
  if ((await video.count()) === 0) await chip.first().click();
  await expectFrames(page, 1);
  // Decoded frames differ run to run: hide the pixels, keep the stage chrome (name, LIVE,
  // controls) in the shots on the stage's black background.
  await page.addStyleTag({ content: 'video { visibility: hidden !important; }' });
  await expect(page.getByTestId('stream-stage')).toBeVisible();
  return pub;
}

/** Stream collapsed to the PiP (remembered for the room) and expanded again. */
async function streamExpandedAgain(page: Page): Promise<void> {
  await page.getByTestId('stream-stage').getByRole('button', { name: 'Свернуть в угол' }).click();
  await expect(page.getByTestId('stream-pip')).toBeVisible();
  await page.getByTestId('stream-pip').getByRole('button', { name: 'Развернуть' }).first().click();
  await expect(page.getByTestId('stream-pip')).toHaveCount(0);
}

/** Two streams (Вера + Борис) + my camera: previews and the camera tile under the stage. */
async function withTwoStreams(page: Page, mock: MockServer): Promise<Publisher[]> {
  const first = await withStream(page, mock);
  await streamExpandedAgain(page);
  const second = await startPublisher({ userId: IDS.users.boris, name: 'Борис Петров', roomId: IDS.rooms.meeting });
  await expect(page.getByTestId('stream-strip').getByRole('button', { name: /^Стрим: / })).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId('stream-strip').getByRole('button', { name: /^Камера: / })).toHaveCount(1);
  await expectFrames(page, 2);
  return [first, second];
}

async function stopAll(pubs: Array<Publisher | null | undefined>): Promise<void> {
  for (const p of pubs) await p?.stop().catch(() => undefined);
}

// ---------------------------------------------------------------- auth

test('auth-login', async ({ open, win, shot }) => {
  await open({ auth: 'out' });
  await expect(win.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
  await checkpoint(shot, 'auth-login');
});

test('auth-server', async ({ open, win, shot }) => {
  await open({ auth: 'out' });
  // docs/09 #19: the server field lives under the «Другой сервер» disclosure.
  await win.getByRole('button', { name: 'Другой сервер' }).click();
  await expect(win.getByLabel('Сервер')).toBeVisible();
  await checkpoint(shot, 'auth-server');
});

test('auth-register', async ({ open, win, shot }) => {
  await open({ auth: 'out' });
  await win.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await expect(win.getByLabel('Имя')).toBeVisible();
  await checkpoint(shot, 'auth-register');
});

// ---------------------------------------------------------------- onboarding

/** The onboarding steps in order; `to` walks there from the first one. */
const ONBOARDING: Array<{ name: string; to: (page: Page) => Promise<void> }> = [
  { name: 'onboarding-mic', to: () => Promise.resolve() },
  {
    name: 'onboarding-mic-ok',
    to: async (p) => {
      await p.getByRole('button', { name: 'Разрешить микрофон' }).click();
      await expect(p.getByTestId('mic-meter')).toBeVisible();
    },
  },
  {
    name: 'onboarding-mode',
    to: async (p) => {
      await p.getByRole('button', { name: 'Разрешить микрофон' }).click();
      await p.getByRole('button', { name: 'Слышно хорошо' }).click();
    },
  },
  {
    name: 'onboarding-mode-ptt',
    to: async (p) => {
      await p.getByRole('button', { name: 'Разрешить микрофон' }).click();
      await p.getByRole('button', { name: 'Слышно хорошо' }).click();
      await p.getByRole('radio', { name: 'Push-to-talk' }).click();
    },
  },
  ...(process.platform === 'darwin'
    ? [
        {
          name: 'onboarding-screen',
          to: async (p: Page) => {
            await p.getByRole('button', { name: 'Разрешить микрофон' }).click();
            await p.getByRole('button', { name: 'Слышно хорошо' }).click();
            await p.getByRole('button', { name: 'Продолжить' }).click();
          },
        },
      ]
    : []),
  {
    name: 'onboarding-notifications',
    to: async (p) => {
      await p.getByRole('button', { name: 'Разрешить микрофон' }).click();
      await p.getByRole('button', { name: 'Слышно хорошо' }).click();
      await p.getByRole('button', { name: 'Продолжить' }).click();
      if (process.platform === 'darwin') await p.getByRole('button', { name: 'Позже' }).click();
    },
  },
  {
    name: 'onboarding-done',
    to: async (p) => {
      await p.getByRole('button', { name: 'Разрешить микрофон' }).click();
      await p.getByRole('button', { name: 'Слышно хорошо' }).click();
      await p.getByRole('button', { name: 'Продолжить' }).click();
      if (process.platform === 'darwin') await p.getByRole('button', { name: 'Позже' }).click();
      await p.getByRole('button', { name: 'Позже' }).click();
    },
  },
];

for (const step of ONBOARDING) {
  test(step.name, async ({ open, win, shot }) => {
    await open({ onboarded: false });
    await step.to(win);
    const id = step.name === 'onboarding-mode-ptt' ? 'onboarding-mode' : step.name === 'onboarding-mic-ok' ? 'onboarding-mic' : step.name;
    await expect(win.getByTestId(id)).toBeVisible();
    await checkpoint(shot, step.name);
  });
}

/** Owner's rule for onboarding (docs/09 #55): the same geometry on every step, no snapshot. */
test('onboarding-layout', async ({ open, win, size: viewport }) => {
  await open({ onboarded: false });
  const onb: OnbGeometry[] = [];
  for (const step of ONBOARDING) {
    await open({ onboarded: false });
    await step.to(win);
    const id = step.name === 'onboarding-mode-ptt' ? 'onboarding-mode' : step.name === 'onboarding-mic-ok' ? 'onboarding-mic' : step.name;
    await expect(win.getByTestId(id)).toBeVisible();
    onb.push(await onboardingGeometry(win, step.name));
  }
  expectStableOnboarding(onb, viewport.height);
});

// ---------------------------------------------------------------- main window

test('main-chat', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await checkpoint(shot, 'main-chat');
});

/**
 * Room drag & drop (docs/09 P1 #19): «разработка» held by the pointer over the top half of
 * «общий» — the room chip follows the pointer, the row fades, the accent line marks the place.
 * Esc cancels: the line goes and nothing moves.
 */
test('sidebar-drag', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const list = win.getByTestId('room-list');
  const from = await list.locator(`[data-room-slot="${IDS.rooms.dev}"]`).boundingBox();
  const to = await list.locator(`[data-room-slot="${IDS.rooms.general}"]`).boundingBox();
  if (!from || !to) throw new Error('room rows are not laid out');
  await win.mouse.move(from.x + 60, from.y + from.height / 2);
  await win.mouse.down();
  await win.mouse.move(from.x + 60, from.y + from.height / 2 - 10, { steps: 4 });
  await win.mouse.move(to.x + 60, to.y + 6, { steps: 8 });
  await expect(win.getByTestId('drop-line')).toBeVisible();
  await settle(win);
  await checkpoint(shot, 'sidebar-drag');
  await win.keyboard.press('Escape');
  await expect(win.getByTestId('drop-line')).toHaveCount(0);
  await win.mouse.up();
  const after = await list.locator('[data-room-slot]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['roomSlot']));
  expect(after.indexOf(IDS.rooms.general)).toBeLessThan(after.indexOf(IDS.rooms.dev));
});

// ---------------------------------------------------------------- localization (ADR-0022)

/**
 * The baselines are Russian; English gets one shot per main screen (`-g "i18n-en"`), dark 960
 * only (the narrowest window, where longer strings would break first) — overflow in other
 * locales is caught by the string-length unit test.
 */
test('i18n-en-main-chat', async ({ open, win, mock, shot, theme, size: viewport }) => {
  test.skip(theme !== 'dark' || viewport.width !== 960, 'English is checked in dark 960 only');
  await open({ prefs: { locale: 'en' } });
  await expect(win.locator('html')).toHaveAttribute('lang', 'en');
  await mainWindow(win, mock);
  await checkpoint(shot, 'i18n-en-main-chat');
});

// ---------------------------------------------------------------- direct messages (ADR-0020)

/**
 * «Личные» (started there: no workspace room is opened and read first, so the rail badges are
 * the READY ones): the DM list — Борис 2 unread, Вера yesterday, Григорий a week ago.
 */
const DM_SEED = { ui: { activeWorkspaceId: '@me' } };
async function dmHome(page: Page): Promise<Locator> {
  await expect(page.getByTestId('rail-home').getByRole('button')).toHaveAttribute('aria-current', 'page');
  const list = page.getByTestId('dm-list');
  await expect(list.getByRole('button')).toHaveCount(3);
  // Previews are fetched when the list opens: wait for all three.
  await expect(list).toContainText('Закрепил, чтобы не потерялся');
  await expect(list).toContainText('Супер, спасибо');
  await expect(list).toContainText('Да, подготовлю пару слайдов');
  return list;
}

test('dm-list', async ({ open, win, shot }) => {
  await open(DM_SEED);
  await dmHome(win);
  await expect(win.getByTestId('dm-pick')).toBeVisible();
  await settle(win);
  await checkpoint(shot, 'dm-list');
});

test('dm-chat', async ({ open, win, shot }) => {
  await open(DM_SEED);
  const list = await dmHome(win);
  await list.getByRole('button', { name: /Борис Петров/ }).click();
  await expect(win.getByTestId('dm-header')).toContainText('Борис Петров');
  await expect(win.locator('[data-message-id]').first()).toBeVisible();
  // The pinned strip (Борис's checklist) and the whole history (4 messages) are in.
  await expect(win.locator('[data-message-id]')).toHaveCount(4);
  await settle(win);
  await win.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await settle(win);
  await checkpoint(shot, 'dm-chat');
});

test('dm-new', async ({ open, win, shot }) => {
  await open(DM_SEED);
  await dmHome(win);
  await win.getByRole('button', { name: 'Новое сообщение' }).first().click();
  const dialog = win.getByRole('dialog', { name: 'Новое сообщение' });
  await expect(dialog.getByRole('option')).toHaveCount(3);
  await settle(win);
  await checkpoint(shot, 'dm-new');
});

test('update-banner', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // Auto-update: «Calab X готова · Перезапустить ✕» in the bottom island (faked status).
  await win.evaluate(() => (window as unknown as { __calabaUpdateStatus?: (s: object) => void }).__calabaUpdateStatus?.({ state: 'downloaded', version: '0.1.1' }));
  await expect(win.getByTestId('update-banner')).toBeVisible();
  await checkpoint(shot, 'update-banner');
});

test('main-members-toggled', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // Members: a column from 1200 px (open by default), a floating panel below (closed by default).
  await win.getByRole('button', { name: 'Участники' }).click();
  await checkpoint(shot, 'main-members-toggled');
});

test('members-profile', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const members = await membersList(win);
  await members.getByRole('button', { name: /Борис Петров/ }).click();
  await expect(win.getByRole('dialog', { name: 'Борис Петров' })).toBeVisible();
  await checkpoint(shot, 'members-profile');
});

test('members-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const members = await membersList(win);
  await members.getByRole('button', { name: /Борис Петров/ }).click({ button: 'right' });
  await expect(win.getByRole('menu')).toBeVisible();
  await checkpoint(shot, 'members-menu');
});

test('profile-dialog', async ({ open, win, mock, shot }) => {
  // docs/09 #20: «Профиль» from the member menu — banner, member since, role chips, the note saved.
  await open();
  await mainWindow(win, mock);
  const members = await membersList(win);
  await members.getByRole('button', { name: /Борис Петров/ }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Профиль' }).click();
  const dialog = win.getByTestId('profile-dialog');
  await expect(dialog).toBeVisible();
  const note = dialog.getByTestId('profile-note');
  await expect(note).toBeEditable();
  await note.fill('Ведёт релизы, спросить про стенд');
  await note.blur();
  await expect(dialog.getByTestId('note-status')).toHaveText('Сохранено');
  await checkpoint(shot, 'profile-dialog');
});

test('quick-switcher', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.keyboard.press(`${MOD}+k`);
  await expect(win.getByRole('dialog')).toBeVisible();
  await checkpoint(shot, 'quick-switcher');
});

test('quick-switcher-filtered', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.keyboard.press(`${MOD}+k`);
  await expect(win.getByRole('dialog')).toBeVisible();
  await win.keyboard.type('раз');
  await checkpoint(shot, 'quick-switcher-filtered');
});

test('chat-header-search', async ({ open, win, mock, shot, size: viewport }) => {
  // docs/09 #50: ≥ 1200 px only (960 keeps the icon); typing opens the ⌘K switcher with the text.
  test.skip(viewport.width < 1200, 'the field shows from 1200 px');
  await open();
  await mainWindow(win, mock);
  const field = win.getByRole('searchbox', { name: 'Поиск: Команда Calab' });
  await expect(field).toBeVisible();
  await field.focus();
  await checkpoint(shot, 'chat-header-search');
  await win.keyboard.type('р');
  await expect(win.getByRole('dialog')).toBeVisible();
  await win.keyboard.type('аз');
  await expect(win.getByRole('dialog').getByRole('combobox')).toHaveValue('раз');
});

test('chat-context-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByTestId('message-bubble').filter({ hasText: 'Готово, выдал' }).click({ button: 'right' });
  await expect(win.getByRole('menu')).toBeVisible();
  await checkpoint(shot, 'chat-context-menu');
});

test('chat-emoji-picker', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: 'Эмодзи' }).click();
  await expect(win.getByRole('dialog', { name: 'Эмодзи' })).toBeVisible();
  await checkpoint(shot, 'chat-emoji-picker');
});

test('chat-search', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: 'Поиск в #общий' }).click();
  await win.keyboard.type('релиз');
  await expect(win.getByText('1 из 3')).toBeVisible();
  await checkpoint(shot, 'chat-search');
});

/**
 * Message action bar (docs/09 #47): checkpoint() parks the pointer, so keyboard focus (Tab /
 * Shift+Tab: :focus-visible, like a real Tab walk); toBeVisible() passes at opacity 0.
 */
async function focusDoneBubble(page: Page): Promise<void> {
  await settle(page);
  const doneBubble = page.getByTestId('message-bubble').filter({ hasText: 'Готово, выдал' });
  // A mouse press never focuses the bubble (only the keyboard draws its focus ring).
  await doneBubble.click();
  await expect(doneBubble).not.toBeFocused();
  await keyboardFocus(doneBubble);
  const actions = page.getByTestId('message-actions');
  await expect(actions).toHaveCount(1);
  await expect(actions).toHaveCSS('opacity', '1');
  await expect(actions.getByRole('button', { name: 'Ответить' })).toBeVisible();
}

test('chat-hover-actions', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await focusDoneBubble(win);
  await checkpoint(shot, 'chat-hover-actions');
});

test('chat-link-preview', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await focusDoneBubble(win);
  // The owner has MANAGE_MESSAGES: «Скрыть превью» on Вера's preview (site colour bar on the left).
  const hidePreview = win.getByTestId('link-preview-hide').first();
  await keyboardFocus(hidePreview);
  await expect(hidePreview).toHaveCSS('opacity', '1');
  // Focus scrolls the feed only «enough», by an amount that varies with row measuring: pin the
  // button 160 px above the feed's bottom edge, re-aligning until the feed stops moving.
  await expect(async () => {
    const off = await hidePreview.evaluate((el) => {
      const feed = el.closest('[data-virtuoso-scroller]') as HTMLElement;
      const d = el.getBoundingClientRect().bottom - (feed.getBoundingClientRect().bottom - 160);
      feed.scrollTop += d;
      return d;
    });
    await settle(win);
    expect(Math.abs(off)).toBeLessThan(1);
  }).toPass({ timeout: 10_000 });
  await expect(hidePreview).toBeFocused();
  await checkpoint(shot, 'chat-link-preview');
});

test('chat-mention-popover', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const composer = win.getByPlaceholder('Сообщение в #общий');
  await composer.click();
  await composer.pressSequentially('@');
  const list = win.getByRole('listbox', { name: 'Упомянуть' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await checkpoint(shot, 'chat-mention-popover');
});

test('chat-notify-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: /^Уведомления:/ }).click();
  await expect(win.getByRole('menuitemradio', { name: 'Только упоминания' })).toBeVisible();
  await checkpoint(shot, 'chat-notify-menu');
});

test('shell-shortcuts', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: 'Горячие клавиши' }).click();
  await expect(win.getByText('Назад по комнатам')).toBeVisible();
  await checkpoint(shot, 'shell-shortcuts');
});

test('shell-mentions', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: /^Упоминания/ }).click();
  // The same text is also in the feed behind the popover: look inside the popover.
  await expect(win.getByRole('dialog').getByText(/посмотришь макет настроек/)).toBeVisible();
  await checkpoint(shot, 'shell-mentions');
});

test('shell-profile', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: /^Мой статус/ }).click();
  await expect(win.getByRole('radiogroup', { name: 'Статус и профиль' })).toBeVisible();
  await checkpoint(shot, 'shell-profile');
});

test('workspace-menu', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
  await expect(win.getByRole('menu')).toBeVisible();
  await checkpoint(shot, 'workspace-menu');
});

/** Settings windows: one test per section (left list = role «tab»), numbered like the snapshots. */
const TABS = { 'workspace-settings': 5, 'room-settings': 3, settings: 9, 'voice-room-settings': 4 } as const;

for (let i = 1; i <= TABS['workspace-settings']; i++) {
  test(`workspace-settings-${i}`, async ({ open, win, mock, shot }) => {
    await open();
    await mainWindow(win, mock);
    await openSettingsTab(
      win,
      async () => {
        await win.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
        await win.getByRole('menuitem', { name: 'Настройки пространства' }).click();
      },
      i,
    );
    await checkpoint(shot, `workspace-settings-${i}`);
  });
}

test('room-create', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await win.getByRole('button', { name: 'Создать комнату' }).first().click();
  await expect(win.getByRole('dialog')).toBeVisible();
  await checkpoint(shot, 'room-create');
});

for (let i = 1; i <= TABS['room-settings']; i++) {
  test(`room-settings-${i}`, async ({ open, win, mock, shot }) => {
    await open();
    await mainWindow(win, mock);
    await openSettingsTab(win, () => win.getByRole('button', { name: 'Настройки комнаты' }).click(), i);
    await checkpoint(shot, `room-settings-${i}`);
  });
}

test('confirm-delete-room', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await openSettingsTab(win, () => win.getByRole('button', { name: 'Настройки комнаты' }).click(), 1);
  await win.getByRole('button', { name: 'Удалить…' }).click();
  await expect(win.getByRole('alertdialog').or(win.getByRole('dialog').last())).toBeVisible();
  await checkpoint(shot, 'confirm-delete-room');
});

const openAppSettings = (page: Page) => async (): Promise<void> => {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
};

for (let i = 1; i <= TABS.settings; i++) {
  test(`settings-${i}`, async ({ open, win, mock, shot }) => {
    await open();
    await mainWindow(win, mock);
    await openSettingsTab(win, openAppSettings(win), i);
    await checkpoint(shot, `settings-${i}`);
  });
}

async function settingsSearch(page: Page): Promise<Locator> {
  await openSettingsTab(page, openAppSettings(page), TABS.settings);
  // docs/09 #18: search over section titles and row labels; Enter jumps to the first row.
  const search = page.getByRole('dialog').getByRole('searchbox', { name: 'Поиск настроек' });
  await search.fill('клав');
  const nav = page.getByRole('navigation', { name: 'Результаты поиска' });
  await expect(nav).toBeVisible();
  // Results are harvested from the (hidden) sections as they render: wait until the list stops
  // growing, or Enter would jump to a partial list.
  let last = -1;
  await expect
    .poll(async () => {
      const n = await nav.getByRole('button').count();
      const stable = n === last;
      last = n;
      return stable && n > 1;
    }, { intervals: [300] })
    .toBe(true);
  return search;
}

test('settings-search', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  await settingsSearch(win);
  await checkpoint(shot, 'settings-search');
});

test('settings-search-jump', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  const search = await settingsSearch(win);
  await search.press('Enter');
  await expect(win.locator('[data-settings-hit="true"]')).toBeVisible();
  await checkpoint(shot, 'settings-search-jump');
});

test('settings-profile-password', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // Profile → «Изменить пароль…»: the sheet over the settings window (current password required).
  await openSettingsTab(win, openAppSettings(win), 1);
  await win.getByRole('button', { name: 'Изменить пароль…' }).click();
  await expect(win.getByRole('dialog', { name: 'Смена пароля' })).toBeVisible();
  await checkpoint(shot, 'settings-profile-password');
});

/** The pop-up button itself (owner bug: chevron flush right): a long value ends with «…» before the ↕. */
async function longSelect(page: Page): Promise<Locator> {
  await openSettingsTab(page, openAppSettings(page), 2);
  const select = page.getByRole('dialog').getByRole('combobox', { name: 'Микрофон' });
  await select.evaluate((el: HTMLSelectElement) => {
    // The value is React-controlled: change the text of the selected option instead.
    const o = el.options[el.selectedIndex];
    if (o) o.text = 'Внешний USB-микрофон с очень длинным названием (Built-in Audio Device)';
  });
  return select;
}

test('select-long', async ({ open, win, mock, theme, size: viewport }) => {
  await open();
  await mainWindow(win, mock);
  const select = await longSelect(win);
  await win.mouse.move(0, 0);
  await expect.soft(select, 'screenshot: select-long').toHaveScreenshot(`select-long-${theme}-${viewport.width}.png`);
});

test('select-hover', async ({ open, win, mock, theme, size: viewport }) => {
  await open();
  await mainWindow(win, mock);
  const select = await longSelect(win);
  await select.hover();
  await expect.soft(select, 'screenshot: select-hover').toHaveScreenshot(`select-hover-${theme}-${viewport.width}.png`);
});

test('toasts', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  // docs/09 #16: glass stack bottom-right; visual-test mode keeps them on screen.
  await win.evaluate(() => {
    type Push = (kind: string, text: string, action?: { label: string; run: () => void }) => void;
    const push = (window as unknown as { __calabaToast?: Push }).__calabaToast;
    push?.('info', 'Ссылка-приглашение скопирована');
    push?.('success', 'Файл сохранён в «Загрузки»');
    push?.('error', 'Не удалось загрузить сообщения. Нет связи с сервером. Проверьте интернет', { label: 'Повторить', run: () => undefined });
  });
  await expect(win.getByTestId('toast')).toHaveCount(3);
  await checkpoint(shot, 'toasts');
});

// ---------------------------------------------------------------- voice (needs the dev LiveKit)

test('voice-room-status-edit', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win, mock);
  await editRoomStatus(win, false);
  await checkpoint(shot, 'voice-room-status-edit');
});

test('voice-room-status', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win, mock);
  await editRoomStatus(win, true);
  // Just joined (docs/09 #10): the invite row is in its 30 s window.
  await expect(win.getByTestId('voice-invite-row')).toBeVisible();
  await checkpoint(shot, 'voice-room-status');
});

// Speaking indication (docs/08): Борис talks — green ring + bright name in the sidebar row
// and the members column; Вера (silent) stays muted. Fixture members have no LiveKit audio, so
// the speaking set is injected (VoiceBar's visual-test hook).
test('voice-room-speaking', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win, mock);
  await editRoomStatus(win, true);
  mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.meeting, muted: false });
  await win.evaluate((id) => (window as unknown as { __calabaSpeaking?: (ids: string[]) => void }).__calabaSpeaking?.([id]), IDS.users.boris);
  const row = win.locator('aside').first().getByRole('listitem', { name: /Борис Петров/ });
  await expect(row).toHaveAttribute('data-speaking', 'true');
  await expect(win.locator('aside').first().getByRole('listitem', { name: /Вера/ })).not.toHaveAttribute('data-speaking', 'true');
  // Joined 60 s ago (docs/09 #10): past the invite row's 30 s window, so both states land in the
  // committed baselines — this screen with it gone, voice-room-status above with it visible.
  await win.evaluate(() => (window as unknown as { __calabaJoinedAt?: (ms: number) => void }).__calabaJoinedAt?.(Date.now() - 60_000));
  await expect(win.getByTestId('voice-invite-row')).toHaveCount(0);
  await checkpoint(shot, 'voice-room-speaking');
});

// Noise suppression popover (docs/09 #12): the wave button in the «Голос подключён» header opens
// it to the right of the island (over the chat, growing upward); the toggle is the same pref as
// Settings → «Голос и устройства». The mic check stays idle in the shot (24 dark segments).
test('voice-noise-popover', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  const button = win.getByTestId('noise-button');
  await expect(button).toHaveAccessibleName('Шумодав включён');
  await button.click();
  const popover = win.getByTestId('noise-popover');
  await expect(popover).toBeVisible();
  const toggle = popover.getByRole('switch', { name: 'Шумоподавление' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(button).toHaveAccessibleName('Шумодав выключен');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(popover.getByTestId('noise-meter')).toHaveAttribute('aria-valuenow', '0');
  // Never over the island: the popover starts right of it.
  const island = await win.getByRole('region', { name: 'Голосовое подключение' }).boundingBox();
  const box = await popover.boundingBox();
  expect(island && box && box.x >= island.x + island.width).toBe(true);
  await checkpoint(shot, 'voice-noise-popover');
});

// A voice room's chat without joining it (docs/09 #14): in a call in «Созвон», the «чат» hover
// action on «Переговорка» (Борис, Вера inside) opens its feed with «Вы не в голосе» + «Войти в
// голос»; the call in «Созвон» stays. (Not the other way round: «Созвон»'s history has an inline
// link, and inline links fail axe link-in-text-block — docs/09.)
test('voice-room-chat-preview', async ({ open, win, mock, shot }) => {
  await open();
  await mainWindow(win, mock);
  mock.injectMessage({ roomId: IDS.rooms.meeting, authorId: IDS.users.boris, content: 'Заходите, обсуждаем план релиза' });
  mock.injectMessage({ roomId: IDS.rooms.meeting, authorId: IDS.users.vera, content: 'Показываю экран с макетами' });
  const sidebar = win.locator('aside').first();
  await sidebar.getByRole('button', { name: /^Созвон/ }).first().click();
  await expect(win.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await win.keyboard.press(`${MOD}+Shift+m`);
  await expect(win.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
  await expect(win.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
  await sidebar.getByRole('button', { name: /^Переговорка/ }).first().hover();
  await sidebar.getByRole('button', { name: 'Чат комнаты «Переговорка»' }).click();
  await expect(win.getByRole('heading', { name: 'Переговорка' })).toBeVisible();
  const preview = win.getByTestId('voice-preview');
  await expect(preview).toContainText('Вы не в голосе');
  await expect(preview.getByRole('button', { name: 'Войти в голос' })).toBeVisible();
  await expect(win.getByRole('region', { name: 'Голосовое подключение' })).toContainText('Созвон');
  await expect(win.getByText('Показываю экран с макетами')).toBeVisible();
  await win.mouse.move(0, 0);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await checkpoint(shot, 'voice-room-chat-preview');
});

// Optimistic join (docs/05, docs/08): Григорий is in the room list at once but still connecting
// (VoiceState.pending) for more than 3 s — the «Подключается…» ring around his avatar (static
// under test-stable) in the sidebar row and the members column.
test('voice-room-pending', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win, mock);
  mock.setVoiceState({ userId: IDS.users.grigory, roomId: IDS.rooms.meeting, pending: true });
  const row = win.locator('aside').first().getByRole('listitem', { name: /Григорий/ });
  await expect(row).toHaveAttribute('data-pending', 'true');
  await expect(row.getByTestId('connect-ring')).toBeVisible({ timeout: 6000 }); // after 3 s
  await checkpoint(shot, 'voice-room-pending');
});

test('toast-device', async ({ open, win, mock, shot }) => {
  await open();
  await inVoice(win, mock);
  await editRoomStatus(win, true);
  // The OS switched the audio device (docs/09 #49): green toast with «Изменить» (faked switch).
  await win.evaluate(() => (window as unknown as { __calabaDeviceToast?: (k: string, l: string) => void }).__calabaDeviceToast?.('input', 'AirPods Pro'));
  await expect(win.getByTestId('toast')).toHaveCount(1);
  await expect(win.getByTestId('toast')).toContainText('Микрофон: AirPods Pro');
  await checkpoint(shot, 'toast-device');
  await win.getByTestId('toast').getByRole('button', { name: 'Изменить' }).click();
  await expect(win.getByRole('dialog').getByRole('tab', { name: 'Голос и устройства' })).toHaveAttribute('data-state', 'active');
});

test('stream-picker', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  // Stream picker (docs/09 #13): synthetic sources from main (CALABA_VISUAL_TEST), no real screens.
  await win.getByRole('button', { name: 'Показать экран' }).first().click();
  await expect(win.getByTestId('stream-source').first()).toBeVisible();
  await checkpoint(shot, 'stream-picker');
});

test('stream-picker-screens', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  await win.getByRole('button', { name: 'Показать экран' }).first().click();
  await expect(win.getByTestId('stream-source').first()).toBeVisible();
  await win.getByRole('radio', { name: 'Весь экран' }).click();
  await win.getByRole('button', { name: 'Дополнительно' }).click();
  await expect(win.getByTestId('stream-advanced')).toBeVisible();
  await checkpoint(shot, 'stream-picker-screens');
});

test('voice-reconnecting', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  // Connection lost (docs/09 #15): the yellow notice in the voice panel.
  await win.evaluate(() => (window as unknown as { __calabaVoicePhase?: (p: string) => void }).__calabaVoicePhase?.('reconnecting'));
  await expect(win.getByTestId('voice-reconnecting')).toBeVisible();
  await checkpoint(shot, 'voice-reconnecting');
});

test('voice-member-menu', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  // Member menu of someone in MY voice room (docs/09 #12): per-user volume + «Заглушить для меня».
  await win.locator('aside').getByRole('listitem', { name: /^Борис Петров/ }).click({ button: 'right' });
  await expect(win.getByRole('menu').getByRole('menuitem', { name: /^Громкость: / })).toBeVisible();
  await checkpoint(shot, 'voice-member-menu');
});

// ---- webcam (docs/09 #41–43)

test('voice-camera-menu', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  await hideCameraPixels(win);
  await win.getByRole('button', { name: 'Выбор камеры' }).click();
  await expect(win.getByRole('menu').getByRole('menuitem', { name: 'Проверить камеру' })).toBeVisible();
  await checkpoint(shot, 'voice-camera-menu');
});

test('camera-preview', async ({ open, win, mock, shot }) => {
  await open();
  await inVoiceWithStatus(win, mock);
  await hideCameraPixels(win);
  // First start: the «Проверьте камеру» sheet with the mirrored preview.
  await win.getByTestId('camera-button').click();
  await expect(win.getByTestId('camera-preview-enable')).toBeEnabled({ timeout: 15_000 });
  await checkpoint(shot, 'camera-preview');
});

test('voice-camera-pip', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withBorisCamera(win, mock);
  try {
    await checkpoint(shot, 'voice-camera-pip');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-camera-grid', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withBorisCamera(win, mock);
  try {
    await cameraGrid(win);
    await checkpoint(shot, 'voice-camera-grid');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-camera-focus', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withBorisCamera(win, mock);
  try {
    await cameraGrid(win);
    // Pin a tile: accent ring + pin badge, «Вернуться к сетке» in the header; Esc unpins.
    const meTile = win.getByRole('button', { name: 'Камера: Анна Смирнова' });
    await meTile.click();
    await expect(meTile).toHaveAttribute('aria-pressed', 'true');
    await expect(win.locator('[data-testid="video-tile"][data-featured]')).toHaveAccessibleName('Камера: Анна Смирнова');
    await expect(win.getByRole('button', { name: 'Вернуться к сетке' })).toBeVisible();
    await checkpoint(shot, 'voice-camera-focus');
    await win.mouse.move(0, 0);
    await win.keyboard.press('Escape');
    await expect(meTile).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-camera-member-menu', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withBorisCamera(win, mock);
  try {
    await cameraGrid(win);
    // Member menu on a tile: local «Не показывать видео», moderator «Выключить камеру».
    await win.getByRole('button', { name: 'Камера: Борис Петров' }).click({ button: 'right' });
    await expect(win.getByRole('menu').getByRole('menuitem', { name: 'Выключить камеру' })).toBeVisible();
    await expect(win.getByRole('menu').getByRole('menuitemcheckbox', { name: 'Не показывать видео' })).toBeVisible();
    await checkpoint(shot, 'voice-camera-member-menu');
  } finally {
    await stopAll([pub]);
  }
});

// ---- stream (the room's chat is empty: docs/09 #56)

test('voice-stream-empty-room', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withStream(win, mock);
  try {
    // The stream opens expanded, the welcome becomes one row under the stage (still visible).
    await expect(win.getByTestId('empty-room')).toHaveAttribute('data-compact', 'true');
    await expect(win.getByTestId('empty-room').getByRole('heading')).toBeInViewport();
    await checkpoint(shot, 'voice-stream-empty-room');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-pip', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withStream(win, mock);
  try {
    // Collapsing to the PiP is remembered for this room; the welcome returns, centred.
    await win.getByTestId('stream-stage').getByRole('button', { name: 'Свернуть в угол' }).click();
    await expect(win.getByTestId('stream-pip')).toBeVisible();
    await expectWelcomeCentred(win);
    await checkpoint(shot, 'voice-pip');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-pip-hover', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withStream(win, mock);
  try {
    await win.getByTestId('stream-stage').getByRole('button', { name: 'Свернуть в угол' }).click();
    // PiP controls (expand / close): shown on hover or keyboard focus. checkpoint() parks the
    // pointer, so the shot uses focus; toBeVisible() passes at opacity 0 — check the opacity.
    const stopWatching = win.getByTestId('stream-pip').getByRole('button', { name: 'Не смотреть' });
    await stopWatching.focus();
    await expect(stopWatching.locator('..')).toHaveCSS('opacity', '1');
    await checkpoint(shot, 'voice-pip-hover');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-stream', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withStream(win, mock);
  try {
    await streamExpandedAgain(win);
    await checkpoint(shot, 'voice-stream');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-stream-controls', async ({ open, win, mock, shot }) => {
  await open();
  const pub = await withStream(win, mock);
  try {
    await streamExpandedAgain(win);
    // Control bar (docs/09 #14): shows on hover / keyboard focus.
    await win.getByTestId('stream-controls').getByRole('button', { name: /^Качество:/ }).focus();
    await checkpoint(shot, 'voice-stream-controls');
  } finally {
    await stopAll([pub]);
  }
});

test('voice-streams-strip', async ({ open, win, mock, shot }) => {
  await open();
  const pubs = await withTwoStreams(win, mock);
  try {
    await checkpoint(shot, 'voice-streams-strip');
  } finally {
    await stopAll(pubs);
  }
});

for (let i = 1; i <= TABS['voice-room-settings']; i++) {
  test(`voice-room-settings-${i}`, async ({ open, win, mock, shot }) => {
    await open();
    const pubs = await withTwoStreams(win, mock);
    try {
      await openSettingsTab(win, () => win.getByRole('button', { name: 'Настройки комнаты' }).click(), i);
      await checkpoint(shot, `voice-room-settings-${i}`);
    } finally {
      await stopAll(pubs);
    }
  });
}

// ---------------------------------------------------------------- first run (no workspaces)

async function firstRun(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Создать пространство' }).first()).toBeVisible();
}

test('welcome', async ({ open, win, shot }) => {
  await open({ scenario: 'empty' });
  await firstRun(win);
  await checkpoint(shot, 'welcome');
});

test('workspace-create', async ({ open, win, shot }) => {
  await open({ scenario: 'empty' });
  await firstRun(win);
  await win.getByRole('button', { name: 'Создать пространство' }).first().click();
  await expect(win.getByRole('dialog')).toBeVisible();
  await checkpoint(shot, 'workspace-create');
});

test('workspace-join', async ({ open, win, shot }) => {
  await open({ scenario: 'empty' });
  await firstRun(win);
  await win.getByRole('button', { name: 'Присоединиться' }).first().click();
  await expect(win.getByRole('dialog')).toBeVisible();
  await checkpoint(shot, 'workspace-join');
});

// ---------------------------------------------------------------- geometry helpers

interface OnbGeometry {
  step: string;
  dots: number;
  title: number;
  card: { top: number; bottom: number; height: number };
  footer: number;
  /** Body centre minus the centre of the space between header and footer (null: no body). */
  bodyOffset: number | null;
  /** Gap above / below the whole composition inside the content area. */
  above: number;
  below: number;
}

async function onboardingGeometry(page: Page, step: string): Promise<OnbGeometry> {
  return page.evaluate((stepName) => {
    const col = document.querySelector('[data-testid^="onboarding-"]');
    const scroller = col?.parentElement;
    const card = col?.querySelector('[data-onb-card]');
    const dots = col?.querySelector('ol');
    const title = col?.querySelector('h1');
    if (!col || !scroller || !card || !dots || !title) throw new Error(`onboarding layout not found (${stepName})`);
    const r = (e: Element): DOMRect => e.getBoundingClientRect();
    const box = r(col);
    const area = r(scroller);
    return {
      step: stepName,
      dots: Math.round(r(dots).top),
      title: Math.round(r(title).top),
      card: { top: Math.round(r(card).top), bottom: Math.round(r(card).bottom), height: Math.round(r(card).height) },
      footer: Math.round(r(col.querySelector('[data-onb-footer]') ?? card).top),
      bodyOffset: (() => {
        const a = col.querySelector('[data-onb-area]');
        const b = col.querySelector('[data-onb-body]');
        if (!a || !b) return null;
        const ra = r(a);
        const rb = r(b);
        return Math.round(rb.top + rb.height / 2 - (ra.top + ra.height / 2));
      })(),
      above: Math.round(box.top - area.top),
      below: Math.round(area.bottom - box.bottom),
    };
  }, step);
}

/**
 * Owner's rule for onboarding: the composition is centred in the window, and on windows ≥ 600 px
 * tall the dots, the title and the card edges (Back/Continue sit on its bottom) stay put between
 * steps — the card is as tall as the tallest step (488 px) and no step outgrows it.
 */
function expectStableOnboarding(steps: OnbGeometry[], windowHeight: number): void {
  for (const g of steps) {
    expect(Math.abs(g.above - g.below), `onboarding centred: ${g.step}`).toBeLessThanOrEqual(2);
    // docs/09 #55: every step has a body, centred between the header and the footer.
    expect(g.bodyOffset, `onboarding body present: ${g.step}`).not.toBeNull();
    expect(Math.abs(g.bodyOffset ?? 99), `onboarding body centred: ${g.step}`).toBeLessThanOrEqual(4);
  }
  if (windowHeight < 600) return;
  const [first] = steps;
  if (!first) return;
  for (const g of steps) {
    expect(g.card.height, `onboarding card height: ${g.step}`).toBe(488);
    expect({ dots: g.dots, title: g.title, card: g.card, footer: g.footer }, `onboarding geometry: ${g.step}`).toEqual({
      dots: first.dots,
      title: first.title,
      card: first.card,
      footer: first.footer,
    });
  }
}

/** Waits until `n` <video> elements show decoded frames (before that a tile shows its placeholder). */
async function expectFrames(page: Page, n: number): Promise<void> {
  await expect
    .poll(() => page.locator('video').evaluateAll((vs) => vs.filter((v) => (v as HTMLVideoElement).readyState >= 2 && (v as HTMLVideoElement).videoWidth > 0).length), {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(n);
  await settle(page);
}

/** docs/09 #56: in an empty room the welcome block sits in the vertical centre of the message area. */
async function expectWelcomeCentred(page: Page): Promise<void> {
  const off = await page.getByTestId('empty-room').evaluate((area) => {
    const w = area.querySelector('[data-testid="empty-room-welcome"]');
    if (!w) return null;
    const a = area.getBoundingClientRect();
    const b = w.getBoundingClientRect();
    return Math.round(b.top + b.height / 2 - (a.top + a.height / 2));
  });
  expect(off, 'empty-room welcome present').not.toBeNull();
  expect(Math.abs(off ?? 99), 'empty-room welcome centred').toBeLessThanOrEqual(4);
}
