import { defineConfig } from '@playwright/test';

// Media publish checks against the dev LiveKit (pnpm infra:dev), no app build and no mock API:
// e2e-media/h264.spec.ts bundles the renderer's publish modules into a page (docs/02 «Кодек»).
//   pnpm -F @calaba/desktop e2e:media
// In a worktree: MOCK_LIVEKIT_ROOM_PREFIX=wt_ keeps the rooms apart from other runs.
export default defineConfig({
  testDir: './e2e-media',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/media',
});
