import { defineConfig } from '@playwright/test';

// Visual regression + layout invariants + accessibility (docs/08, «Тесты дизайна»).
// Self-contained: starts the deterministic mock API (e2e-support/) and the production
// renderer from out/. Needs the dev LiveKit (pnpm infra:dev) for the voice/stream shots.
//   pnpm e2e:visual            — compare with the committed snapshots
//   pnpm e2e:visual:update     — re-record after an intended design change
// CALABA_VISUAL_OUT: separate result folders for parallel local runs.
// In a git worktree always run with its own mock port and LiveKit room prefix (README «Parallel
// visual runs»): CALABA_VISUAL_MOCK_PORT=39270 MOCK_LIVEKIT_ROOM_PREFIX=wt_ CALABA_VISUAL_OUT=test-results/wt
const OUT = process.env['CALABA_VISUAL_OUT'] ?? 'test-results/visual';

/**
 * screens.spec.ts: one project per configuration, one test per screen (named like its snapshot).
 *   -g "voice-camera-grid"                  every configuration
 *   -g "voice-camera-grid" --project dark-1440
 * Workers run screens in parallel, each with its own Electron app, mock port and LiveKit room
 * prefix (e2e-visual/app.ts). CALABA_VISUAL_WORKERS overrides the count (default 3).
 */
const CONFIGS = [
  { name: 'dark-960', theme: 'dark', viewport: { width: 960, height: 600 } },
  { name: 'dark-1440', theme: 'dark', viewport: { width: 1440, height: 800 } },
  { name: 'light-960', theme: 'light', viewport: { width: 960, height: 600 } },
  { name: 'light-1440', theme: 'light', viewport: { width: 1440, height: 800 } },
] as const;

/** The per-project options of e2e-visual/app.ts (kept here: the node tsconfig doesn't include e2e files). */
interface VisualOptions {
  theme: 'dark' | 'light';
  size: { width: number; height: number };
}

export default defineConfig<VisualOptions>({
  testDir: './e2e-visual',
  timeout: 120_000,
  workers: Number(process.env['CALABA_VISUAL_WORKERS'] ?? 3),
  projects: [
    ...CONFIGS.map((c) => ({ name: c.name, testMatch: /screens\.spec\.ts/, use: { theme: c.theme, size: c.viewport } })),
    // Focus walk and the web client's own screens (they start their own mock / app).
    { name: 'misc', testMatch: /(focus|web)\.spec\.ts/ },
  ],
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
