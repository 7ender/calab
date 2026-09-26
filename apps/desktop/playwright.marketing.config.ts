import { defineConfig } from '@playwright/test';

// Real macOS screenshots of the packaged app for README and the landing (docs/09 #52):
//   pnpm build && pnpm screenshots:marketing   (needs the dev LiveKit: pnpm infra:dev)
// Writes 2x PNGs to ../../docs/images: a 1440 pt wide window as tall as the display allows
// (≤ 900 pt; 871 pt on a 14" MacBook → 2880×1742 px). No resizing, no 1x copies. macOS only.
export default defineConfig({
  testDir: './e2e-marketing',
  timeout: 300_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/marketing',
  expect: { timeout: 20_000 },
});
