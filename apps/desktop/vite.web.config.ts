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

/**
 * Web app icons (owner artwork, build/icons/web — see scripts/gen-icons.sh): the files are the
 * `publicDir`, this adds the <link>s and the PWA manifest. Only for the web build: the Electron
 * window/Dock/tray icons come from electron-builder and main.
 */
const WEB_THEME = '#1c1c1e'; // --color-bg (dark), the app opens dark by default
function webIcons(): Plugin {
  const manifest = {
    name: 'Calaba',
    short_name: 'Calaba',
    start_url: '/',
    display: 'standalone',
    background_color: WEB_THEME,
    theme_color: WEB_THEME,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return {
    name: 'calaba:web-icons',
    transformIndexHtml: () => [
      { tag: 'link', attrs: { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'icon', href: '/favicon-32.png', sizes: '32x32', type: 'image/png' }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' }, injectTo: 'head' },
      { tag: 'meta', attrs: { name: 'theme-color', content: WEB_THEME }, injectTo: 'head' },
    ],
    // dev/preview serve it from memory, build emits it next to index.html
    configureServer(server) {
      server.middlewares.use('/manifest.webmanifest', (_req, res) => {
        res.setHeader('Content-Type', 'application/manifest+json');
        res.end(JSON.stringify(manifest));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify(manifest, null, 2) });
    },
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
    plugins: [react(), tailwindcss(), stripMetaCsp(), webIcons()],
    publicDir: resolve(__dirname, 'build/icons/web'),
    build: {
      outDir: resolve(__dirname, 'dist-web'),
      emptyOutDir: true,
      target: 'es2022',
      // No source maps in the deployed bundle (review): nothing consumes them (no error
      // reporting service yet) and they would publish the full client source. For debugging a
      // build: CALABA_WEB_SOURCEMAP=1 → 'hidden' maps (files only, no sourceMappingURL comment).
      sourcemap: (env['CALABA_WEB_SOURCEMAP'] ?? process.env['CALABA_WEB_SOURCEMAP']) === '1' ? 'hidden' : false,
      rollupOptions: {
        output: {
          // Vendor chunks change less often than the app: better caching across deploys, and no
          // single 1.6 MB chunk.
          manualChunks(id: string): string | undefined {
            if (!id.includes('node_modules')) return undefined;
            if (/[\\/]node_modules[\\/](livekit-client|@livekit)[\\/]/.test(id)) return 'livekit';
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
            if (/[\\/]node_modules[\\/]@bufbuild[\\/]/.test(id)) return 'protobuf';
            return undefined;
          },
        },
      },
    },
    server: { port: 5174, strictPort: true, proxy },
    // CALABA_WEB_CSP: emulate the stand's Content-Security-Policy header in `preview` (TESTING.md).
    preview: { port: 4173, strictPort: true, proxy, ...(env['CALABA_WEB_CSP'] ? { headers: { 'Content-Security-Policy': env['CALABA_WEB_CSP'] } } : {}) },
  };
});
