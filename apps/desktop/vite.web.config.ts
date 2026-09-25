import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Web client build (ADR-0015): the same renderer, VITE_PLATFORM=web (.env.web), no
 * Electron main/preload. `vite build --config vite.web.config.ts --mode web` → dist-web/.
 * `vite preview` serves dist-web and proxies /api + /gateway to a local API
 * (CALABA_WEB_PROXY, default http://127.0.0.1:3000) — same origin, like Caddy on the stand.
 */
const require = createRequire(import.meta.url);
const rnnoiseDist = dirname(require.resolve('@timephy/rnnoise-wasm'));
const version = (require('./package.json') as { version: string }).version;

/** The CSP of the web build comes from the server (Caddy); the Electron meta CSP is dropped. */
function stripMetaCsp(): Plugin {
  return {
    name: 'calaba:strip-meta-csp',
    transformIndexHtml: (html) => html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/, ''),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const target = env['CALABA_WEB_PROXY'] ?? process.env['CALABA_WEB_PROXY'] ?? 'http://127.0.0.1:3000';
  const proxy = {
    '/api': { target, changeOrigin: false },
    '/gateway': { target, ws: true, changeOrigin: false },
  };
  return {
    root: resolve(__dirname, 'src/renderer'),
    base: '/',
    envDir: __dirname,
    define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
    resolve: { alias: { '@rnnoise-dist': rnnoiseDist } },
    worker: { format: 'es' },
    plugins: [react(), tailwindcss(), stripMetaCsp()],
    build: {
      outDir: resolve(__dirname, 'dist-web'),
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: true,
    },
    server: { port: 5174, strictPort: true, proxy },
    // CALABA_WEB_CSP: emulate the stand's Content-Security-Policy header in `preview` (TESTING.md).
    preview: { port: 4173, strictPort: true, proxy, ...(env['CALABA_WEB_CSP'] ? { headers: { 'Content-Security-Policy': env['CALABA_WEB_CSP'] } } : {}) },
  };
});
