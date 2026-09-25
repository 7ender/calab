/**
 * IPC contract between main and renderer (via preload). Keep it narrow:
 * every channel here is an explicit capability granted to the renderer.
 */
export const IPC = {
  // ---- auth (main is the token broker; the refresh token never leaves main) ----
  authRestore: 'auth:restore',
  authLogin: 'auth:login',
  authRegister: 'auth:register',
  authLogout: 'auth:logout',
  authAccessToken: 'auth:access-token',
  authForceRefresh: 'auth:force-refresh',
  /** main → renderer: the session ended (refresh failed / revoked / logout elsewhere). */
  authLoggedOut: 'auth:logged-out',

  // ---- app ----
  appInfo: 'app:info',
  appGetSettings: 'app:get-settings',
  appSetSettings: 'app:set-settings',
  appTakeDeepLink: 'app:take-deep-link',
  /** main → renderer */
  appDeepLink: 'app:deep-link',
  /** main → renderer: power events (resume after sleep → force gateway reconnect). */
  appPower: 'app:power',
  appCheckUpdates: 'app:check-updates',
  /** main → renderer */
  appUpdateStatus: 'app:update-status',
  appLog: 'app:log',
  appOpenExternal: 'app:open-external',
  appAttention: 'app:attention',

  // ---- tray ----
  trayState: 'tray:state',
  /** main → renderer */
  trayAction: 'tray:action',

  // ---- files ----
  filesDownload: 'files:download',

  // ---- media ----
  captureListSources: 'capture:list-sources',
  captureSelectSource: 'capture:select-source',
  pttSetBinding: 'ptt:set-binding',
  pttCaptureNext: 'ptt:capture-next',
  pttStatus: 'ptt:status',
  /** main → renderer push: PTT key pressed/released. */
  pttEvent: 'ptt:event',
  systemOpenPrivacySettings: 'system:open-privacy-settings',
  /** CPU of this window's renderer + GPU process (dev stats panel). */
  systemMetrics: 'system:metrics',
} as const;

/** Scheme through which the renderer talks to the API; main adds auth and forwards. */
export const API_SCHEME = 'calaba-api';
/** `calaba-api://api/api/me` → `<serverUrl>/api/me`. */
export const API_ORIGIN = `${API_SCHEME}://api`;

// ---------------------------------------------------------------- auth

/** ApiError JSON (proto calaba.v1.ApiError, protojson) plus the HTTP status. */
export interface ApiErrorJson {
  code: string;
  message: string;
  field?: string;
  status: number;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ApiErrorJson };

export interface AuthSession {
  serverUrl: string;
  sessionId: string;
  /** calaba.v1.Me as protojson; the renderer decodes it with MeSchema. */
  me: unknown;
}

export interface LoginArgs {
  serverUrl: string;
  email: string;
  password: string;
}

export interface RegisterArgs extends LoginArgs {
  displayName: string;
  inviteCode: string;
}

export type LogoutReason = 'logout' | 'expired' | 'revoked';

// ---------------------------------------------------------------- app

export interface AppSettings {
  /** API base URL, e.g. https://app.example.com (no trailing slash). */
  serverUrl: string;
  /** electron-updater generic feed URL; empty = updates off. */
  updateUrl: string;
  autostart: boolean;
}

export interface AppInfo {
  version: string;
  platform: string;
  hostname: string;
  electron: string;
  chrome: string;
  packaged: boolean;
  /** Test/automation flag (fake media devices). */
  fakeMedia: boolean;
  systemAudioLoopback: 'supported' | 'experimental' | 'unsupported';
  micAccess: string;
  screenAccess: string;
}

export type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

export type UpdateStatus =
  | { state: 'disabled' }
  | { state: 'checking' }
  | { state: 'none' }
  | { state: 'available'; version: string }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

export interface TrayState {
  inVoice: boolean;
  muted: boolean;
  deafened: boolean;
}

export type TrayAction = 'toggle-mute' | 'toggle-deafen' | 'disconnect' | 'show';

export interface DownloadArgs {
  fileId: string;
  name: string;
}

// ---------------------------------------------------------------- media

export type CaptureSourceKind = 'screen' | 'window';

export interface CaptureSource {
  id: string;
  name: string;
  kind: CaptureSourceKind;
  /** PNG data URL, 320×180 max. Empty when the OS denied screen recording. */
  thumbnail: string;
  displayId: string;
}

export interface CaptureSelection {
  sourceId: string;
  /** Request system audio loopback (see docs/02-media.md, rule 4). */
  audio: boolean;
}

/** A global PTT binding: keyboard key (uiohook keycode) or mouse button. */
export type PttBinding =
  | { kind: 'key'; code: number; label: string }
  | { kind: 'mouse'; code: number; label: string };

export interface PttStatus {
  active: boolean;
  binding: PttBinding | null;
  /** macOS: Accessibility trust; always true elsewhere. */
  trusted: boolean;
  error: string | null;
}

export interface PttEvent {
  down: boolean;
}

export type PrivacyPane = 'accessibility' | 'input-monitoring' | 'screen' | 'microphone';

export interface ProcessMetrics {
  /** % of one core (like ps/top), averaged since the previous sample. */
  rendererCpu: number | null;
  gpuCpu: number | null;
  mainCpu: number | null;
  rendererPid: number;
}
