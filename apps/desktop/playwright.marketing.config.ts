import { defineConfig } from '@playwright/test';

// Landing + README screenshots per UI language: e2e-marketing/landing.spec.ts (`-g landing`, the
// renderer out/, raw captures in apps/landing/shots, see apps/landing/README.md).
// shots.spec.ts — real macOS screenshots of the packaged app (docs/09 #52, on demand):
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
