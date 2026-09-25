import type {
  CaptureSelection,
  CaptureSource,
  MintTokenRequest,
  PrivacyPane,
  ProcessMetrics,
  PttBinding,
  PttEvent,
  PttStatus,
  SystemInfo,
} from '../shared/ipc';

/** API exposed to the renderer as `window.calaba` (see src/preload/index.ts). */
export interface CalabaApi {
  spike: {
    /** SPIKE ONLY: dev token from main; the real app gets tokens from the API. */
    mintToken(req: MintTokenRequest): Promise<string>;
    openWindow(): Promise<void>;
  };
  capture: {
    listSources(): Promise<CaptureSource[]>;
    /** Arms the next getDisplayMedia() call of this window with the chosen source. */
    selectSource(sel: CaptureSelection): Promise<void>;
  };
  ptt: {
    setBinding(binding: PttBinding | null): Promise<PttStatus>;
    /** Resolves with the next key/mouse button pressed anywhere (global). */
    captureNext(): Promise<PttBinding>;
    status(): Promise<PttStatus>;
    /** Subscribe to global PTT key down/up. Returns an unsubscribe function. */
    onEvent(cb: (ev: PttEvent) => void): () => void;
  };
  system: {
    info(): Promise<SystemInfo>;
    metrics(): Promise<ProcessMetrics>;
    openPrivacySettings(pane: PrivacyPane): Promise<void>;
  };
}

declare global {
  interface Window {
    calaba: CalabaApi;
  }
}
