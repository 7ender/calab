import { expect, test, type Page } from '@playwright/test';
import { IDS } from '../e2e-support/mock-server';
import { THEMES, VIEWPORTS, checkpoint, launch, login, settle, type Env, type Shot } from './harness';
import { startPublisher } from './publisher';

/**
 * Visual regression of every main screen (docs/08, «Тесты дизайна»): dark + light, 960 and
 * 1440 px wide. Each checkpoint = screenshot (≤ 0.2 % differing pixels) + layout invariants +
 * axe (0 serious/critical). Update the baseline: `pnpm e2e:visual:update`.
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Settings windows: photograph every section (left list = role «tab»). */
async function everyTab(s: Shot, prefix: string): Promise<void> {
  const dialog = s.page.getByRole('dialog');
  const tabs = dialog.getByRole('tab');
  const n = await tabs.count();
  for (let i = 0; i < n; i++) {
    const tab = tabs.nth(i);
    await tab.click();
    await expect(tab).toHaveAttribute('data-state', 'active');
    await checkpoint(s, `${prefix}-${i + 1}`);
  }
}

async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test.describe(`${theme} ${viewport.width}`, () => {
      let env: Env | undefined;
      // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures argument
      test.afterEach(async ({}, info) => {
        if (env && info.status !== info.expectedStatus) {
          // Electron pages are not covered by Playwright's `screenshot` option.
          await info.attach('failure', { body: await env.page.screenshot().catch(() => Buffer.alloc(0)), contentType: 'image/png' });
        }
        await env?.close();
      });

      test('auth → onboarding → app screens', async () => {
        env = await launch({ theme, viewport });
        const { page, mock } = env;
        const s: Shot = { page, theme, viewport };

        // ---- auth
        await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
        await checkpoint(s, 'auth-login');
        // docs/09 #19: the server field lives under the «Другой сервер» disclosure.
        await page.getByRole('button', { name: 'Другой сервер' }).click();
        await expect(page.getByLabel('Сервер')).toBeVisible();
        await checkpoint(s, 'auth-server');
        await page.getByRole('button', { name: 'Скрыть' }).click();
        await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
        await expect(page.getByLabel('Имя')).toBeVisible();
        await checkpoint(s, 'auth-register');
        await page.getByRole('button', { name: 'Войти', exact: true }).last().click();
        await login(page);

        // ---- onboarding (the fixed OS statuses come from CALABA_VISUAL_TEST)
        const onb: OnbGeometry[] = [];
        await expect(page.getByTestId('onboarding-mic')).toBeVisible();
        await checkpoint(s, 'onboarding-mic');
        onb.push(await onboardingGeometry(page, 'onboarding-mic'));
        await page.getByRole('button', { name: 'Разрешить микрофон' }).click();
        await expect(page.getByTestId('mic-meter')).toBeVisible();
        await checkpoint(s, 'onboarding-mic-ok');
        onb.push(await onboardingGeometry(page, 'onboarding-mic-ok'));
        await page.getByRole('button', { name: 'Слышно хорошо' }).click();
        await expect(page.getByTestId('onboarding-mode')).toBeVisible();
        await checkpoint(s, 'onboarding-mode');
        onb.push(await onboardingGeometry(page, 'onboarding-mode'));
        await page.getByRole('radio', { name: 'Push-to-talk' }).click();
        await checkpoint(s, 'onboarding-mode-ptt');
        onb.push(await onboardingGeometry(page, 'onboarding-mode-ptt'));
        await page.getByRole('radio', { name: 'Активация голосом' }).click();
        await page.getByRole('button', { name: 'Продолжить' }).click();
        if (process.platform === 'darwin') {
          await expect(page.getByTestId('onboarding-screen')).toBeVisible();
          await checkpoint(s, 'onboarding-screen');
          onb.push(await onboardingGeometry(page, 'onboarding-screen'));
          await page.getByRole('button', { name: 'Позже' }).click();
        }
        await expect(page.getByTestId('onboarding-notifications')).toBeVisible();
        await checkpoint(s, 'onboarding-notifications');
        onb.push(await onboardingGeometry(page, 'onboarding-notifications'));
        await page.getByRole('button', { name: 'Позже' }).click();
        await expect(page.getByTestId('onboarding-done')).toBeVisible();
        await checkpoint(s, 'onboarding-done');
        onb.push(await onboardingGeometry(page, 'onboarding-done'));
        expectStableOnboarding(onb, viewport.height);
        await page.getByRole('button', { name: 'Начать' }).click();

        // ---- main window with data
        await page.locator('aside').getByRole('button', { name: /общий/ }).first().click();
        await expect(page.getByRole('heading', { name: 'общий' })).toBeVisible();
        mock.injectMessage({ roomId: IDS.rooms.dev, authorId: IDS.users.boris, content: `@${IDS.users.anna} глянь, пожалуйста, ревью` });
        // Mention badge on «разработка»: 1 from the history loaded at startup + this live one.
        await expect(page.locator('aside').first().getByText('2', { exact: true })).toBeVisible();
        // The room opens at the first unread; that anchor lands ±1 px apart between runs
        // (fractional row heights). Photograph the feed at its bottom, which is exact.
        // Only after the history is in and the app placed the first-unread anchor, or the app
        // re-positions the list after our scroll.
        await expect(page.locator('[data-message-id]').first()).toBeVisible();
        await settle(page);
        await page.locator('[data-virtuoso-scroller]').first().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
        await checkpoint(s, 'main-chat');

        // Members: a column from 1200 px (open by default), a floating panel below (closed by default).
        await page.getByRole('button', { name: 'Участники' }).click();
        await checkpoint(s, 'main-members-toggled');
        await page.getByRole('button', { name: 'Участники' }).click();

        // Members list: profile popover and member context menu (docs/09 #12).
        const members = page.getByRole('complementary', { name: 'Участники' });
        if (!(await members.isVisible())) await page.getByRole('button', { name: 'Участники' }).click();
        await members.getByRole('button', { name: /Борис Петров/ }).click();
        await expect(page.getByRole('dialog', { name: 'Борис Петров' })).toBeVisible();
        await checkpoint(s, 'members-profile');
        await page.keyboard.press('Escape');
        await members.getByRole('button', { name: /Борис Петров/ }).click({ button: 'right' });
        await expect(page.getByRole('menu')).toBeVisible();
        await checkpoint(s, 'members-menu');
        await page.keyboard.press('Escape');
        if (await page.getByRole('complementary', { name: 'Участники' }).evaluate((el) => el.classList.contains('mat-popover'))) {
          await page.getByRole('button', { name: 'Участники' }).click();
        }

        // ---- quick switcher
        await page.keyboard.press(`${MOD}+k`);
        await expect(page.getByRole('dialog')).toBeVisible();
        await checkpoint(s, 'quick-switcher');
        await page.keyboard.type('раз');
        await checkpoint(s, 'quick-switcher-filtered');
        await closeDialog(page);

        // ---- chat (docs/09 #36–#39): context menu, emoji picker, in-room search
        await page.getByTestId('message-bubble').filter({ hasText: 'Готово, выдал' }).click({ button: 'right' });
        await expect(page.getByRole('menu')).toBeVisible();
        await checkpoint(s, 'chat-context-menu');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Эмодзи' }).click();
        await expect(page.getByRole('dialog', { name: 'Эмодзи' })).toBeVisible();
        await checkpoint(s, 'chat-emoji-picker');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Поиск в #общий' }).click();
        await page.keyboard.type('релиз');
        await expect(page.getByText('1 из 3')).toBeVisible();
        await checkpoint(s, 'chat-search');
        await page.keyboard.press('Escape');

        // ---- mentions (docs/05): composer autocomplete, room notification menu
        const composer = page.getByPlaceholder('Сообщение в #общий');
        await composer.click();
        await composer.pressSequentially('@');
        await expect(page.getByRole('listbox', { name: 'Упомянуть' })).toBeVisible();
        await checkpoint(s, 'chat-mention-popover');
        await page.keyboard.press('Escape');
        await composer.fill('');
        await page.getByRole('button', { name: /^Уведомления:/ }).click();
        await expect(page.getByRole('menuitemradio', { name: 'Только упоминания' })).toBeVisible();
        await checkpoint(s, 'chat-notify-menu');
        await page.keyboard.press('Escape');
        // Focus returns to the bell and its tooltip opens (keyboard-focus tooltip); at 960 it
        // covers the title bar. Close it before the next step.
        await page.keyboard.press('Escape');
        await expect(page.getByRole('tooltip')).toHaveCount(0);

        // ---- shell popovers (docs/09 #1, #6): title bar help + mentions, self profile/status
        await page.getByRole('button', { name: 'Горячие клавиши' }).click();
        await expect(page.getByText('Назад по комнатам')).toBeVisible();
        await checkpoint(s, 'shell-shortcuts');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: /^Упоминания/ }).click();
        // The same text is also in the feed behind the popover: look inside the popover.
        await expect(page.getByRole('dialog').getByText(/посмотришь макет настроек/)).toBeVisible();
        await checkpoint(s, 'shell-mentions');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: /^Мой статус/ }).click();
        await expect(page.getByRole('radiogroup', { name: 'Статус и профиль' })).toBeVisible();
        await checkpoint(s, 'shell-profile');
        await page.keyboard.press('Escape');

        // ---- workspace menu + settings
        await page.locator('aside').getByRole('button', { name: /Команда Calab/ }).click();
        await expect(page.getByRole('menu')).toBeVisible();
        await checkpoint(s, 'workspace-menu');
        await page.getByRole('menuitem', { name: 'Настройки пространства' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await everyTab(s, 'workspace-settings');
        await closeDialog(page);

        // ---- room create + room settings + destructive confirm
        await page.getByRole('button', { name: 'Создать комнату' }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await checkpoint(s, 'room-create');
        await closeDialog(page);

        await page.getByRole('button', { name: 'Настройки комнаты' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await everyTab(s, 'room-settings');
        await page.getByRole('dialog').getByRole('tab').first().click();
        await page.getByRole('button', { name: 'Удалить…' }).click();
        await expect(page.getByRole('alertdialog').or(page.getByRole('dialog').last())).toBeVisible();
        await checkpoint(s, 'confirm-delete-room');
        await page.getByRole('button', { name: 'Отмена' }).click();
        await closeDialog(page);

        // ---- app settings (every section)
        await page.getByRole('button', { name: 'Настройки', exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await everyTab(s, 'settings');
        // docs/09 #18: search over section titles and row labels; Enter jumps to the first row.
        const search = page.getByRole('dialog').getByRole('searchbox', { name: 'Поиск настроек' });
        await search.fill('клав');
        await expect(page.getByRole('navigation', { name: 'Результаты поиска' })).toBeVisible();
        await checkpoint(s, 'settings-search');
        await search.press('Enter');
        await expect(page.locator('[data-settings-hit="true"]')).toBeVisible();
        await checkpoint(s, 'settings-search-jump');
        await page.keyboard.press('Escape'); // clears the search, the window stays
        await expect(search).toHaveValue('');
        // Profile → «Изменить пароль…»: the sheet over the settings window (current password required).
        await page.getByRole('dialog').getByRole('tab', { name: 'Профиль' }).click();
        await page.getByRole('button', { name: 'Изменить пароль…' }).click();
        const passwordSheet = page.getByRole('dialog', { name: 'Смена пароля' });
        await expect(passwordSheet).toBeVisible();
        await checkpoint(s, 'settings-profile-password');
        await page.keyboard.press('Escape');
        await expect(passwordSheet).toHaveCount(0);
        // The pop-up button itself (owner bug: chevron flush right): a long value must end with
        // «…» before the ↕ chevron (8 px inset); hover is a step lighter.
        await page.getByRole('dialog').getByRole('tab', { name: 'Голос и устройства' }).click();
        const select = page.getByRole('dialog').getByRole('combobox', { name: 'Микрофон' });
        await select.evaluate((el: HTMLSelectElement) => {
          // The value is React-controlled: change the text of the selected option instead.
          const o = el.options[el.selectedIndex];
          if (o) o.text = 'Внешний USB-микрофон с очень длинным названием (Built-in Audio Device)';
        });
        await page.mouse.move(0, 0);
        await expect.soft(select, 'screenshot: select-long').toHaveScreenshot(`select-long-${theme}-${viewport.width}.png`);
        await select.hover();
        await expect.soft(select, 'screenshot: select-hover').toHaveScreenshot(`select-hover-${theme}-${viewport.width}.png`);
        await closeDialog(page);

        // ---- toasts (docs/09 #16): glass stack bottom-right; visual-test mode keeps them on screen
        await page.evaluate(() => {
          type Push = (kind: string, text: string, action?: { label: string; run: () => void }) => void;
          const push = (window as unknown as { __calabaToast?: Push }).__calabaToast;
          push?.('info', 'Ссылка-приглашение скопирована');
          push?.('success', 'Файл сохранён в «Загрузки»');
          push?.('error', 'Не удалось загрузить сообщения. Нет связи с сервером. Проверьте интернет', { label: 'Повторить', run: () => undefined });
        });
        await expect(page.getByTestId('toast')).toHaveCount(3);
        await checkpoint(s, 'toasts');
        for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Закрыть уведомление' }).first().click();
        await expect(page.getByTestId('toast')).toHaveCount(0);

        // ---- voice room + stream (needs the dev LiveKit)
        await page.locator('aside').getByRole('button', { name: /Переговорка/ }).first().click();
        await expect(page.getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
        await page.keyboard.press(`${MOD}+Shift+m`); // muted: the fake mic beeps → speaking rings would flicker
        await expect(page.getByRole('button', { name: 'Включить микрофон' }).first()).toBeVisible();
        // Signal bars stay in the shots (docs/08: quality always visible): wait for the loopback
        // LiveKit's steady «good» instead of masking the indicator.
        await expect(page.getByRole('button', { name: /^Качество связи: Хорошее/ })).toBeVisible({ timeout: 15_000 });

        // Stream picker (docs/09 #13): synthetic sources from main (CALABA_VISUAL_TEST), no real screens.
        await page.getByRole('button', { name: 'Показать экран' }).first().click();
        await expect(page.getByTestId('stream-source').first()).toBeVisible();
        await checkpoint(s, 'stream-picker');
        await page.getByRole('radio', { name: 'Весь экран' }).click();
        await page.getByRole('button', { name: 'Дополнительно' }).click();
        await expect(page.getByTestId('stream-advanced')).toBeVisible();
        await checkpoint(s, 'stream-picker-screens');
        await closeDialog(page);

        // Connection lost (docs/09 #15): the yellow notice in the voice panel.
        await page.evaluate(() => (window as unknown as { __calabaVoicePhase?: (p: string) => void }).__calabaVoicePhase?.('reconnecting'));
        await expect(page.getByTestId('voice-reconnecting')).toBeVisible();
        await checkpoint(s, 'voice-reconnecting');
        await page.evaluate(() => (window as unknown as { __calabaVoicePhase?: (p: string) => void }).__calabaVoicePhase?.('connected'));
        await expect(page.getByTestId('voice-reconnecting')).toHaveCount(0);

        // Member menu of someone in MY voice room (docs/09 #12): per-user volume + «Заглушить для меня».
        await page.locator('aside').getByRole('listitem', { name: /^Борис Петров/ }).click({ button: 'right' });
        await expect(page.getByRole('menu').getByRole('menuitem', { name: /^Громкость: / })).toBeVisible();
        await checkpoint(s, 'voice-member-menu');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('menu')).toHaveCount(0);

        // LiveKit creates the room on the first join, so the publisher comes second.
        const publisher = await startPublisher({ userId: IDS.users.vera, name: 'Вера Ким', roomId: IDS.rooms.meeting });
        let second: Awaited<ReturnType<typeof startPublisher>> | null = null;
        try {
          const video = page.locator('video');
          const chip = page.getByRole('button', { name: 'Вера Ким', exact: true });
          await expect(video.or(chip).first()).toBeVisible({ timeout: 30_000 });
          if ((await video.count()) === 0) await chip.first().click();
          await expect(video.first()).toBeVisible();
          await expectFrames(page, 1);
          // Decoded frames differ run to run: hide the pixels, keep the stage chrome (name, LIVE,
          // controls) in the shots on the stage's black background.
          await page.addStyleTag({ content: 'video { visibility: hidden !important; }' });
          // Default stage while chatting: PiP in the top-right corner, clear of the composer.
          await expect(page.getByTestId('stream-pip')).toBeVisible();
          await checkpoint(s, 'voice-pip');
          // PiP hover controls (expand / close).
          await page.getByTestId('stream-pip').hover();
          await expect(page.getByTestId('stream-pip').getByRole('button', { name: 'Не смотреть' })).toBeVisible();
          await checkpoint(s, 'voice-pip-hover');
          await page.getByTestId('stream-pip').getByRole('button', { name: 'Развернуть' }).first().click();
          await expect(page.getByTestId('stream-pip')).toHaveCount(0);
          await checkpoint(s, 'voice-stream');
          // Control bar (docs/09 #14): shows on hover / keyboard focus.
          await page.getByTestId('stream-controls').getByRole('button', { name: /^Качество:/ }).focus();
          await checkpoint(s, 'voice-stream-controls');
          // Several streams: a strip of previews under the stage.
          second = await startPublisher({ userId: IDS.users.boris, name: 'Борис Петров', roomId: IDS.rooms.meeting });
          await expect(page.getByTestId('stream-strip').getByRole('button')).toHaveCount(2, { timeout: 30_000 });
          await expectFrames(page, 2);
          await checkpoint(s, 'voice-streams-strip');
          await page.getByRole('button', { name: 'Настройки комнаты' }).click();
          await expect(page.getByRole('dialog')).toBeVisible();
          await everyTab(s, 'voice-room-settings');
          await closeDialog(page);
          await page.getByRole('button', { name: 'Отключиться' }).click();
        } finally {
          await second?.stop();
          await publisher.stop();
        }
      });

      test('first run without workspaces', async () => {
        env = await launch({ theme, viewport, scenario: 'empty', onboarded: true });
        await login(env.page);
        await expect(env.page.getByRole('button', { name: 'Создать пространство' }).first()).toBeVisible();
        const s: Shot = { page: env.page, theme, viewport };
        await checkpoint(s, 'welcome');
        await env.page.getByRole('button', { name: 'Создать пространство' }).first().click();
        await expect(env.page.getByRole('dialog')).toBeVisible();
        await checkpoint(s, 'workspace-create');
        await closeDialog(env.page);
        await env.page.getByRole('button', { name: 'Присоединиться' }).first().click();
        await expect(env.page.getByRole('dialog')).toBeVisible();
        await checkpoint(s, 'workspace-join');
        await closeDialog(env.page);
      });
    });
  }
}

interface OnbGeometry {
  step: string;
  dots: number;
  title: number;
  card: { top: number; bottom: number; height: number };
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
      above: Math.round(box.top - area.top),
      below: Math.round(area.bottom - box.bottom),
    };
  }, step);
}

/**
 * Owner's rule for onboarding: the composition is centred in the window, and on windows ≥ 700 px
 * tall the dots, the title and the card edges (Back/Continue sit on its bottom) stay put between
 * steps — the card is as tall as the tallest step (500 px) and no step outgrows it.
 */
function expectStableOnboarding(steps: OnbGeometry[], windowHeight: number): void {
  for (const g of steps) expect(Math.abs(g.above - g.below), `onboarding centred: ${g.step}`).toBeLessThanOrEqual(2);
  if (windowHeight < 700) return;
  const [first] = steps;
  if (!first) return;
  for (const g of steps) {
    expect(g.card.height, `onboarding card height: ${g.step}`).toBe(500);
    expect({ dots: g.dots, title: g.title, card: g.card }, `onboarding geometry: ${g.step}`).toEqual({ dots: first.dots, title: first.title, card: first.card });
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

