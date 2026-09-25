import { defineConfig } from 'vitest/config';

// Smoke test of the mock server; separate from the package's unit-test config (src/**).
// Run: pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts
export default defineConfig({
  test: { include: ['e2e-support/**/*.test.ts'], root: new URL('..', import.meta.url).pathname, testTimeout: 20_000 },
});
