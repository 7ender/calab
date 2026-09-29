import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { IDS } from '../e2e-support/fixtures';
import type { ResumeVoice } from '../src/shared/resumeVoice';
import { MOCK_PORT, NOW, launch, login, type Env } from './harness';

/**
 * docs/09 #126: after a restart for an update the app takes the same room again. The restart
 * itself (electron-updater's quitAndInstall + relaunch) cannot run here; its trace is: main finds
 * userData/resume-voice.json at startup, the first READY takes it and joins the stored room with
 * the stored mic state. Behaviour only, no screenshots.
 *
 *   pnpm -F @calaba/desktop e2e:visual --project resume-voice
 */

// Its own mock port: the per-screen workers use MOCK_PORT + 1 + n, focus.spec MOCK_PORT.
const PORT = MOCK_PORT + 40;

let env: Env | undefined;
test.afterAll(async () => {
  await env?.close();
});

test('restart for an update: the first READY rejoins the stored room, muted as it was', async () => {
  test.setTimeout(120_000);
  let file = '';
  const e = await launch({
    theme: 'dark',
    viewport: { width: 960, height: 600 },
    onboarded: true,
    port: PORT,
    seedUserData: (dir, serverUrl) => {
      const rec: ResumeVoice = {
        kind: 'room',
        roomId: IDS.rooms.call,
        workspaceId: IDS.workspaces.main,
        userId: IDS.users.anna,
        muted: true,
        deafened: false,
        mutedBeforeDeafen: false,
        cameraOn: true, // not restored
        serverUrl,
        // The renderer runs on the harness's fixed clock.
        at: NOW.getTime() - 30_000,
      };
      file = join(dir, 'resume-voice.json');
      writeFileSync(file, JSON.stringify(rec));
    },
  });
  env = e;
  await login(e.page);
  await expect(e.page.locator('aside').first()).toBeVisible({ timeout: 30_000 });

  // The join reached the server for the stored room (the mock records the device as pending).
  await expect
    .poll(async () => {
      const r = await fetch(`${e.mock.url}/__mock/voice`);
      const voice = (await r.json()) as Record<string, { roomId: string } | undefined>;
      return voice[IDS.users.anna]?.roomId ?? '';
    }, { timeout: 15_000 })
    .toBe(IDS.rooms.call);
  // The mic comes back muted; the camera stays off.
  await expect(e.page.getByRole('button', { name: 'Включить микрофон', exact: true })).toBeVisible();
  await expect(e.page.getByRole('button', { name: 'Выключить камеру', exact: true })).toHaveCount(0);
  // Taken once: main no longer has it, and the file is gone (a later manual launch joins nothing).
  expect(await e.page.evaluate<unknown>('window.calaba.app.takeResumeVoice()')).toBeNull();
  expect(existsSync(file)).toBe(false);
});
