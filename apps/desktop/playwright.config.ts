import { defineConfig } from '@playwright/test';

// E2E against a real API server: CALABA_E2E_SERVER_URL=http://localhost:3000 pnpm e2e
// (the app is launched from the production build in out/, see e2e/app.spec.ts).
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
