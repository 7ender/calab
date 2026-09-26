/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** Build-time default API URL for packaged builds (e.g. the staging stand). */
  readonly MAIN_VITE_DEFAULT_SERVER_URL?: string;
  /** Build-time override of the update feed (https only); default from the server (shared/updateFeed.ts). */
  readonly MAIN_VITE_UPDATE_URL?: string;
  /** '1' for signed builds: macOS auto-download + install too (Windows / AppImage always, updateFlow.ts). */
  readonly MAIN_VITE_UPDATES_SIGNED?: string;
  /** Extra CSP connect-src sources (e.g. LiveKit on another domain), space-separated (review L3). */
  readonly MAIN_VITE_CSP_CONNECT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
