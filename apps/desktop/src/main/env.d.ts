/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** Build-time default API URL for packaged builds (e.g. the staging stand). */
  readonly MAIN_VITE_DEFAULT_SERVER_URL?: string;
  /** Build-time electron-updater generic feed URL. */
  readonly MAIN_VITE_UPDATE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
