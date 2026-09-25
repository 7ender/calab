/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'web' for the browser build (ADR-0015); unset = Electron renderer. */
  readonly VITE_PLATFORM?: 'web';
  readonly VITE_APP_VERSION?: string;
}
