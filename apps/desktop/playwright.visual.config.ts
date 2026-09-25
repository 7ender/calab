import { defineConfig } from '@playwright/test';

// Visual regression + layout invariants + accessibility (docs/08, «Тесты дизайна»).
// Self-contained: starts the deterministic mock API (e2e-support/) and the production
// renderer from out/. Needs the dev LiveKit (pnpm infra:dev) for the voice/stream shots.
//   pnpm e2e:visual            — compare with the committed snapshots
//   pnpm e2e:visual:update     — re-record after an intended design change
// CALABA_VISUAL_OUT: separate result folders for parallel local runs.
const OUT = process.env['CALABA_VISUAL_OUT'] ?? 'test-results/visual';

export default defineConfig({
  testDir: './e2e-visual',
  timeout: 240_000,
  workers: 1,
  // Electron + LiveKit on one machine: one retry; a retried test is reported as «flaky».
  retries: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `${OUT}-report` }]],
  outputDir: OUT,
  // Snapshots are per-OS (fonts/rendering differ); the committed baseline is macOS.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  use: { trace: 'retain-on-failure' },
});
