import { defineConfig, devices } from '@playwright/test';

// Web client E2E (ADR-0015). Needs dist-web served same-origin with the API:
//   CALABA_WEB_PROXY=http://127.0.0.1:3000 pnpm preview:web   (or the stand)
//   CALABA_WEB_URL=http://localhost:4173 pnpm e2e:web
// The API must list that origin in PUBLIC_APP_URL (CSRF / cookie checks).
export default defineConfig({
  testDir: './e2e-web',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: process.env['CALABA_WEB_URL'] ?? 'http://localhost:4173', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true },
        },
      },
    },
  ],
});
