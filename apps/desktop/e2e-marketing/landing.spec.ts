import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RecordingStatus } from '@calaba/protocol';
import { devices, webkit, type Locator, type Page } from '@playwright/test';
import { IDS, startMockServer, type MockServer } from '../e2e-support/mock-server';
import { expect, test } from '../e2e-visual/app';
import { NOW, settle } from '../e2e-visual/harness';
import { startPublisher } from '../e2e-visual/publisher';

/**
 * Landing and README screenshots (docs/09 #97, #110): the mock-driven renderer (out/, like the
 * visual tests — no packaged app), a 1440×900 pt window captured at the display's scale (2x on a
 * Retina Mac). Every scene is set up once in Russian (the selectors) and then photographed in each
 * UI language, switched live through the visual-test hook `__calabaLocale` (App.tsx): mock people
 * and rooms stay Russian, the UI chrome follows the page's language.
 * Raw full-window captures go to apps/landing/shots/<shot>-<locale>-<theme>@2x.png (git-ignored);
 * `pnpm -F @calaba/landing assets` crops them into public/screens/*.webp and docs/images/readme/.
 *   pnpm -F @calaba/desktop build:app && pnpm -F @calaba/desktop build:web
 *   cd apps/desktop && CALABA_VISUAL_MOCK_PORT=39370 MOCK_LIVEKIT_ROOM_PREFIX=landing_ \
 *     pnpm exec playwright test --config playwright.marketing.config.ts -g landing
 * dark; again with CALABA_LANDING_THEME=light. CALABA_LANDING_LOCALES=ru,en narrows the languages.
 * Needs the dev LiveKit (pnpm infra:dev) for the voice, stream, camera and call scenes.
 */
const OUT = resolve(import.meta.dirname, '../../landing/shots');
const SIZE = { width: 1440, height: 900 };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const DIST_WEB = resolve(import.meta.dirname, '../dist-web');

/** Landing locale (route segment, file name) → the app's locale. */
const ALL_LOCALES = [
  ['ru', 'ru'],
  ['en', 'en'],
  ['es', 'es'],
  ['zh', 'zh-CN'],
] as const;
type Short = (typeof ALL_LOCALES)[number][0];
const wanted = process.env['CALABA_LANDING_LOCALES']?.split(',').map((s) => s.trim());
const LOCALES = ALL_LOCALES.filter(([s]) => !wanted || wanted.includes(s));

// Worker-scoped options can't change per describe: one theme per run (CALABA_LANDING_THEME).
const theme = process.env['CALABA_LANDING_THEME'] === 'light' ? 'light' : 'dark';
test.use({ theme, size: SIZE });

type Hook = { __calabaLocale?: (l: string) => void };

async function setLocale(page: Page, locale: string): Promise<void> {
  await page.evaluate((l) => (window as unknown as Hook).__calabaLocale?.(l), locale);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

async function shoot(page: Page, file: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${file}@2x.png`);
  await page.screenshot({ path, scale: 'device', animations: 'disabled', caret: 'hide' });
  console.log(file, `${(statSync(path).size / 1e6).toFixed(1)} MB`);
}

/**
 * Photographs the current scene in every language: switch, let `after` re-pin what the switch
 * moved (the feed's bottom), capture; back to Russian at the end (the next steps' selectors).
 */
async function everyLocale(page: Page, name: string, after?: () => Promise<void>, only?: readonly Short[]): Promise<void> {
  for (const [short, app] of LOCALES) {
    if (only && !only.includes(short)) continue;
    await setLocale(page, app);
    await after?.();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    await shoot(page, `${name}-${short}-${theme}`);
  }
  await setLocale(page, 'ru');
}

async function feedBottom(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await settle(page);
  }
}

const feedAfter = (page: Page) => () => feedBottom(page);

async function general(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
  await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
  await expect(page.locator('[data-message-id]').first()).toBeVisible();
  await settle(page);
}

/** Two badges of «Команда Calab» (as screens.spec): «Acme» on Борис and Вера, «Globex» on Анна. */
function badges(mock: MockServer): void {
  const acme = mock.addBadge(IDS.workspaces.main, 'Acme', { bg: [255, 159, 10], fg: [255, 255, 255] });
  const globex = mock.addBadge(IDS.workspaces.main, 'Globex', { bg: [48, 209, 88], fg: [0, 64, 32] });
  mock.setMemberBadge(IDS.workspaces.main, IDS.users.boris, acme);
  mock.setMemberBadge(IDS.workspaces.main, IDS.users.vera, acme);
  mock.setMemberBadge(IDS.workspaces.main, IDS.users.anna, globex);
}

async function badgesLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => [...document.querySelectorAll('img[data-member-badge]')].every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0));
}

/** In «Переговорка» (dev LiveKit), muted (the fake mic beeps), a room status, signal «good». */
async function inVoice(page: Page): Promise<void> {
  const sidebar = page.locator('aside').first();
  await sidebar.getByRole('button', { name: /Переговорка/ }).first().click();
  await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press(`${MOD}+Shift+m`);
  await expect(page.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
  await sidebar.getByTestId('voice-status-row').click();
  await sidebar.getByTestId('voice-status-input').fill('Планёрка по релизу 0.8');
  await sidebar.getByTestId('voice-status-input').press('Enter');
  await expect(sidebar.getByTestId('voice-status-row')).toContainText('Планёрка');
  // Joined a minute ago: past the «Пригласить» row's 30 s window and the just-joined dots.
  await page.evaluate(() => (window as unknown as { __calabaJoinedAt?: (ms: number) => void }).__calabaJoinedAt?.(Date.now() - 60_000));
  await expect(page.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });
}

async function speaking(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((list) => (window as unknown as { __calabaSpeaking?: (ids: string[]) => void }).__calabaSpeaking?.(list), ids);
}

async function workspaceSettings(page: Page, tab: string): Promise<Locator> {
  await page.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
  await page.getByRole('menuitem', { name: 'Настройки пространства' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: tab }).click();
  return dialog;
}

// ---- hero + voice: «общий» while in voice (Борис speaking, badges, a mention on «разработка»),
// then the noise popover over the island.
test(`landing hero ${theme}`, async ({ open, win, mock }) => {
  await open();
  await general(win);
  badges(mock);
  mock.injectMessage({ roomId: IDS.rooms.dev, authorId: IDS.users.boris, content: `@${IDS.users.anna} глянь, пожалуйста, ревью` });
  await inVoice(win);
  mock.setVoiceState({ userId: IDS.users.boris, roomId: IDS.rooms.meeting, muted: false });
  await general(win);
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.boris, content: 'Созвон через 5 минут в «Переговорке», слайды уже в чате' });
  await expect(win.locator('[data-message-id] img[data-member-badge]').last()).toBeVisible();
  await speaking(win, [IDS.users.boris]);
  await badgesLoaded(win);
  await feedBottom(win);
  await everyLocale(win, 'hero', feedAfter(win));

  await win.getByTestId('noise-button').click();
  const toggle = win.getByTestId('noise-popover').getByRole('switch', { name: 'Шумоподавление' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  // A language switch re-mounts the popover's switch unchecked for a moment: on again if so.
  const sw = win.getByTestId('noise-popover').getByRole('switch');
  await everyLocale(win, 'voice', async () => {
    await win.waitForTimeout(500);
    if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await win.mouse.move(0, 0);
  });
});

// ---- stream: Вера shares a release slide into «Переговорка», the stage expanded.
test(`landing stream ${theme}`, async ({ open, win }) => {
  await open();
  await general(win);
  await inVoice(win);
  const pub = await startPublisher({
    userId: IDS.users.vera,
    name: 'Вера Ким',
    roomId: IDS.rooms.meeting,
    image: readFileSync(resolve(import.meta.dirname, '../e2e-support/assets/stream-slide.png')),
  });
  try {
    const video = win.getByTestId('stream-stage').or(win.getByTestId('stream-pip'));
    const chip = win.getByRole('button', { name: 'Вера Ким', exact: true });
    await expect(video.or(chip).first()).toBeVisible({ timeout: 30_000 });
    if ((await video.count()) === 0) await chip.first().click();
    await expect.poll(() => win.locator('video').first().evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.videoWidth > 0), { timeout: 30_000 }).toBe(true);
    const expand = win.getByTestId('stream-pip').getByRole('button', { name: 'Развернуть' });
    if (await expand.count()) await expand.first().click();
    await expect(win.getByTestId('stream-stage')).toBeVisible();
    await speaking(win, [IDS.users.boris]);
    await win.waitForTimeout(1000);
    await everyLocale(win, 'stream');
  } finally {
    await pub.stop().catch(() => undefined);
  }
});

/**
 * Chromium's fake camera (a green test pattern) replaced by a calm picture: a built-in room
 * background (bg-05) with a drawn person in front, as a canvas stream (the page's camera requests
 * only; the background effect then runs on it as on a real camera).
 */
async function fakeCamera(page: Page): Promise<void> {
  const room = `data:image/webp;base64,${readFileSync(resolve(import.meta.dirname, '../src/renderer/assets/backgrounds/bg-05.webp')).toString('base64')}`;
  await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 720;
    const g = c.getContext('2d');
    if (!g) return;
    const draw = (): void => {
      g.drawImage(img, 0, 0, c.width, c.height);
      // Shoulders (a dark sweater), neck, head, hair.
      g.fillStyle = '#2c3e50';
      g.beginPath();
      g.moveTo(400, 720);
      g.bezierCurveTo(410, 560, 480, 520, 640, 515);
      g.bezierCurveTo(800, 520, 870, 560, 880, 720);
      g.fill();
      g.fillStyle = '#d9a383';
      g.fillRect(605, 430, 70, 100);
      g.beginPath();
      g.ellipse(640, 360, 95, 120, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#3b2a20';
      g.beginPath();
      g.ellipse(640, 300, 102, 78, 0, Math.PI, Math.PI * 2);
      g.fill();
    };
    draw();
    setInterval(draw, 100);
    const stream = c.captureStream(10);
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => (constraints?.video ? new MediaStream(stream.getVideoTracks().map((t) => t.clone())) : orig(constraints));
  }, room);
}

// ---- camera: the first-start preview with «Фон» — light blur chosen, the workspace pictures.
test(`landing camera ${theme}`, async ({ open, win, mock }) => {
  await open();
  await general(win);
  await inVoice(win);
  mock.addBackground(IDS.workspaces.main, 'Офис', { from: [44, 62, 80], to: [189, 195, 199] });
  mock.addBackground(IDS.workspaces.main, 'Логотип', { from: [10, 132, 255], to: [94, 92, 230] });
  await fakeCamera(win);
  await win.getByTestId('camera-button').click();
  await expect(win.getByTestId('camera-preview-enable')).toBeEnabled({ timeout: 15_000 });
  await expect(win.getByTestId('camera-bg-workspace').getByRole('radio')).toHaveCount(2);
  await win.getByTestId('camera-bg').getByRole('radio', { name: 'Лёгкое' }).click();
  await win.waitForFunction(() => [...document.querySelectorAll('img[data-wsbg-thumb]')].every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0));
  await expect(win.getByTestId('camera-bg-loading')).toHaveCount(0, { timeout: 30_000 });
  await win.waitForTimeout(1000);
  await everyLocale(win, 'camera');
});

// ---- chat: a forwarded message over an ordinary composer (the mock's stickers are placeholder shapes).
test(`landing chat ${theme}`, async ({ open, win, mock }) => {
  await open();
  await general(win);
  mock.injectMessage({
    roomId: IDS.rooms.general,
    authorId: IDS.users.vera,
    content: 'Итоги релиза: всё выкатили, мониторинг зелёный.',
    forward: { authorId: IDS.users.boris, sentAtMs: Date.parse('2026-01-14T16:05:00Z'), roomId: IDS.rooms.dev },
  });
  mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.users.boris, content: 'Отлично!' });
  await expect(win.getByTestId('forward-line')).toHaveCount(1);
  await feedBottom(win);
  // Memoized feed rows keep the forward line's language after a live switch: re-open the room.
  await everyLocale(win, 'chat', async () => {
    await win.locator('aside').getByRole('button', { name: /разработка/ }).first().click();
    await general(win);
    await expect(win.getByTestId('forward-line')).toHaveCount(1);
    await feedBottom(win);
  });
});

// ---- one-to-one call in «Личные»: accepted, in progress (header «Звонок · 00:00», the island).
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
  await everyLocale(win, 'call', feedAfter(win));
  await win.getByTestId('dm-call-hangup').click();
});

// ---- a done meeting recording: the card with the summary, playing at 0:02 (the play circle's
// progress ring), «Ответить», «Полный транскрипт».
test(`landing recording ${theme}`, async ({ open, win, mock }) => {
  await open();
  await general(win);
  mock.injectMessage({ roomId: IDS.rooms.meeting, authorId: IDS.users.boris, content: 'Спасибо всем, запись будет в чате' });
  mock.injectRecordingCard({ roomId: IDS.rooms.meeting, byUserId: IDS.users.boris, durationSec: 42 * 60 + 10, status: RecordingStatus.DONE, result: true });
  const sidebar = win.locator('aside').first();
  await sidebar.getByRole('button', { name: /^Переговорка/ }).first().hover();
  await sidebar.getByRole('button', { name: 'Чат комнаты «Переговорка»' }).click();
  await expect(win.getByRole('heading', { name: 'Переговорка' })).toBeVisible();
  const card = win.getByTestId('recording-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('recording-card-summary')).toContainText('Релиз 0.7');
  // Keep the chat player's <audio> to pause it at an exact second.
  await win.evaluate(() => {
    const proto = HTMLMediaElement.prototype;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound with `.call(this)` below
    const play = proto.play;
    proto.play = function (this: HTMLMediaElement) {
      (window as unknown as { __calabaAudio?: HTMLMediaElement }).__calabaAudio = this;
      return play.call(this);
    };
  });
  const circle = card.getByTestId('recording-card-play');
  await card.getByRole('button', { name: 'Слушать запись' }).click();
  await expect(circle).toHaveAttribute('data-playing', 'true');
  await expect(card.getByTestId('recording-card-time')).toContainText('/ 0:06');
  await card.getByRole('button', { name: 'Пауза' }).click();
  await expect(circle).not.toHaveAttribute('data-playing');
  await win.evaluate(() => {
    const el = (window as unknown as { __calabaAudio?: HTMLMediaElement }).__calabaAudio;
    if (el) el.currentTime = 2;
  });
  await expect(card.getByTestId('recording-card-time')).toHaveText('0:02 / 0:06');
  await feedBottom(win);
  await everyLocale(win, 'recording', feedAfter(win));
});

// ---- README only (ru): workspace settings → «Бейджи».
test(`landing badges ${theme}`, async ({ open, win, mock }) => {
  await open();
  await general(win);
  badges(mock);
  const dialog = await workspaceSettings(win, 'Бейджи');
  await expect(dialog.getByTestId('badge-row')).toHaveCount(2);
  await badgesLoaded(win);
  await everyLocale(win, 'badges', undefined, ['ru']);
});

// ---- mobile web: iPhone 14 in WebKit (Safari's engine), «общий» (needs dist-web).
test(`landing mobile ${theme}`, async () => {
  test.skip(!existsSync(join(DIST_WEB, 'index.html')), 'dist-web is missing: run `pnpm build:web` first');
  const mock = await startMockServer({ port: 0, scenario: 'data', staticDir: DIST_WEB });
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ ...devices['iPhone 14'], deviceScaleFactor: 2, locale: 'ru-RU', timezoneId: 'Europe/Moscow', colorScheme: theme });
    const page = await context.newPage();
    await page.clock.setFixedTime(NOW);
    await page.goto(`${mock.url}/?visual-test`);
    await page.evaluate((t) => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme: t, onboarded: true, locale: 'ru' }, version: 1 })), theme);
    await page.goto(`${mock.url}/?visual-test`);
    // Notch / home-indicator insets of an iPhone 14 (WebKit here has no real safe area).
    await page.addStyleTag({ content: '@media (max-width: 768px) { :root.web { --safe-top: 47px; --safe-bottom: 34px; } }' });
    await page.getByLabel('Email').fill('owner@calaba.test');
    await page.getByLabel('Пароль', { exact: true }).fill('password123');
    await page.getByRole('button', { name: 'Войти', exact: true }).tap();
    await expect(page.getByTestId('mobile-shell')).toBeVisible();
    await page.getByRole('button', { name: 'Комнаты и пространства' }).first().tap();
    await page.getByTestId('mobile-nav').getByRole('button', { name: /^общий/ }).first().tap();
    await expect(page.getByTestId('mobile-nav')).toHaveCount(0);
    await expect(page.locator('[data-message-id]').first()).toBeVisible();
    await feedBottom(page);
    await everyLocale(page, 'mobile', feedAfter(page));
    await context.close();
  } finally {
    await browser.close();
    await mock.close();
  }
});
