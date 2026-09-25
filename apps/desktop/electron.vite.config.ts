import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

// @timephy/rnnoise-wasm only exports its ready-made worklet, which discards the
// RNNoise VAD probability. We need VAD for voice activation (docs/02-media.md),
// so our own worklet imports the package internals (sync WASM glue + atob
// polyfill) through this alias, bypassing the package "exports" map.
const rnnoiseDist = dirname(require.resolve('@timephy/rnnoise-wasm'));

/**
 * The renderer owns live media objects (Room, AudioContext, tracks) in module
 * singletons. Partial HMR would duplicate them (UI bound to one instance, media
 * to another), so every change in dev triggers a full reload instead.
 */
function fullReloadOnly(): Plugin {
  return {
    name: 'calaba:full-reload-only',
    apply: 'serve',
    handleHotUpdate({ server }) {
      server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@rnnoise-dist': rnnoiseDist,
      },
    },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
    // Pre-bundle the worklet's deps at startup: otherwise Vite discovers them on
    // the first mic start and force-reloads the page in the middle of connect().
    optimizeDeps: {
      include: ['@rnnoise-dist/polyfills.js', '@rnnoise-dist/generated/rnnoise-sync.js', 'livekit-client'],
    },
    worker: { format: 'es' },
    plugins: [react(), fullReloadOnly()],
  },
});
