/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** Build-time default API URL for packaged builds (e.g. the staging stand). */
  readonly MAIN_VITE_DEFAULT_SERVER_URL?: string;
  /** Build-time override of the update feed (https only); default `<server>/download/`. */
  readonly MAIN_VITE_UPDATE_URL?: string;
  /** '1' only for signed builds: enables auto-download + install on quit (review M3). */
  readonly MAIN_VITE_UPDATES_SIGNED?: string;
  /** Extra CSP connect-src sources (e.g. LiveKit on another domain), space-separated (review L3). */
  readonly MAIN_VITE_CSP_CONNECT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
