import type { KeySource } from './keySource';
import type { PttMode } from './pttGate';

/**
 * IPC contract between main and renderer (via preload). Keep it narrow:
 * every channel here is an explicit capability granted to the renderer.
 */
export const IPC = {
  // ---- auth (main is the token broker; the refresh token never leaves main) ----
  authRestore: 'auth:restore',
  authLogin: 'auth:login',
  authRegister: 'auth:register',
  authGuestJoin: 'auth:guest-join',
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
  /** The current update status (a reloaded renderer does not miss a downloaded update). */
  appGetUpdateStatus: 'app:get-update-status',
  /** Restart now and install the downloaded update. */
  appInstallUpdate: 'app:install-update',
  /** main → renderer */
  appUpdateStatus: 'app:update-status',
  /** renderer → main: the `online` event (main has none) — a throttled update check. */
  appNetworkOnline: 'app:network-online',
  appLog: 'app:log',
  appOpenExternal: 'app:open-external',
  appLegal: 'app:legal',
  appAttention: 'app:attention',
  /** Mentions + unread DM messages → Dock badge / badge count / tray tooltip (docs/09 item 22). */
  appSetBadge: 'app:set-badge',
  /** Renderer theme → nativeTheme.themeSource (vibrancy follows the app theme). */
  appSetTheme: 'app:set-theme',
  /** Renderer locale → the few strings main shows itself (tray, notifications, window titles; ADR-0022). */
  appSetStrings: 'app:set-strings',
  /** macOS permission statuses + requesting microphone access (onboarding). */
  systemPermissions: 'system:permissions',
  systemRequestMic: 'system:request-mic',
  /** Screen Recording status + whether capture actually works now (onboarding). */
  screenAccess: 'screen:access',
  /**
   * macOS: register the app in the Screen Recording list (a capture attempt — TCC lists an app
   * only after its first try) and open that Privacy pane (docs/09 P0 #3).
   */
  screenRequestAccess: 'screen:requestAccess',
  /** Quit and start again (macOS applies a new Screen Recording grant only after a relaunch). */
  appRelaunch: 'app:relaunch',

  // ---- tray ----
  trayState: 'tray:state',
  /** main → renderer */
  trayAction: 'tray:action',

  // ---- files ----
  filesDownload: 'files:download',
  filesProgress: 'files:progress',

  // ---- media ----
  captureListSources: 'capture:list-sources',
  captureSelectSource: 'capture:select-source',
  /**
   * The sender's own BrowserWindow in native full screen (docs/09 #18: the stream's «На весь
   * экран»; macOS: its own Space on the window's display). Leaving restores the bounds saved on
   * entry. The main window and a stream pop-out each call it for themselves.
   */
  windowSetFullScreen: 'window:setFullScreen',
  windowIsFullScreen: 'window:isFullScreen',
  /** main → renderer: the window entered / left full screen (also by the OS: ⌃⌘F, green button). */
  windowFullScreenChanged: 'window:fullScreenChanged',
  pttSetBinding: 'ptt:set-binding',
  pttCaptureNext: 'ptt:capture-next',
  /** The binder closed: disarm a pending capture (review H2). */
  pttCancelCapture: 'ptt:cancel-capture',
  pttStatus: 'ptt:status',
  /** main → renderer push: PTT key pressed/released. */
  pttEvent: 'ptt:event',
  /** main → renderer push while a capture is armed: raw key event (PttRawKey, diagnostics). */
  pttRawKey: 'ptt:raw-key',
  systemOpenPrivacySettings: 'system:open-privacy-settings',
  /** CPU of this window's renderer + GPU process (dev stats panel). */
  systemMetrics: 'system:metrics',
  /** Seconds since the last keyboard/mouse input anywhere in the OS (AFK presence). */
  systemIdleSeconds: 'system:idle-seconds',
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
  /**
   * «Автоматически обновлять» (default on): download in the background and install on restart /
   * quit where the platform can (Windows, Linux AppImage, signed macOS). Off → notify only.
   */
  autoUpdate: boolean;
  /**
   * «Проверять обновления автоматически» (default on): at start, hourly, after wake / unlock /
   * back online. Off → only «Проверить» in «О программе».
   */
  autoCheckUpdates: boolean;
}

/** Licence texts for «О программе» (BUSL-1.1 LICENSE, NOTICE, commercial terms, third-party notices). */
export interface LegalTexts {
  license: string;
  notice: string;
  commercial: string;
  thirdParty: string;
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
  /** Test flag CALABA_FORCE_RELAY=1: ICE relay-only (checks the TURN/TLS 443 path). */
  forceRelay: boolean;
  /** Test flag CALABA_VISUAL_TEST=1: no native vibrancy, no animations (deterministic screenshots). */
  visualTest: boolean;
  systemAudioLoopback: 'supported' | 'experimental' | 'unsupported';
  micAccess: string;
  screenAccess: string;
  /** OS / app UI languages, most preferred first (`app.getLocale()`, then the system list; ADR-0022). */
  locales: string[];
}

/** Strings main shows itself, translated by the renderer (ADR-0022). Main starts with the Russian ones. */
export interface MainStrings {
  trayOpen: string;
  trayMute: string;
  trayDeafen: string;
  trayDisconnect: string;
  trayQuit: string;
  trayInVoice: string;
  trayInVoiceMuted: string;
  /** `{version}` placeholder. */
  updateAvailable: string;
  /** Tray item when an update is downloaded; `{version}` placeholder. */
  trayRestartUpdate: string;
  streamWindow: string;
}

export const MAIN_STRING_KEYS = [
  'trayOpen',
  'trayMute',
  'trayDeafen',
  'trayDisconnect',
  'trayQuit',
  'trayInVoice',
  'trayInVoiceMuted',
  'updateAvailable',
  'trayRestartUpdate',
  'streamWindow',
] as const satisfies ReadonlyArray<keyof MainStrings>;

export type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

export type UpdateStatus =
  | { state: 'disabled' }
  | { state: 'checking' }
  | { state: 'none' }
  /**
   * Notify-only (unsigned macOS, Linux without AppImage, «Автоматически обновлять» off):
   * `downloadPage` is the feed / download page the user opens.
   */
  | { state: 'available'; version: string; downloadPage?: string }
  /** Background download; `percent` is an integer 0–100. */
  | { state: 'downloading'; version: string; percent: number }
  /** Ready: installs on «Перезапустить» or on quit. */
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

/** Attachment download progress (main → renderer), from Chromium's DownloadItem. */
export interface DownloadProgress {
  fileId: string;
  received: number;
  /** 0 = unknown. */
  total: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
}

// ---------------------------------------------------------------- media

export type CaptureSourceKind = 'screen' | 'window';

export interface CaptureSource {
  id: string;
  name: string;
  kind: CaptureSourceKind;
  /** PNG data URL at the requested thumbnail size (shared/captureThumb). Empty when the OS denied screen recording. */
  thumbnail: string;
  displayId: string;
  /** PNG data URL of the owning app's icon (windows only; empty when unknown). */
  appIcon?: string;
}

export interface CaptureSelection {
  sourceId: string;
  /** Request system audio loopback (see docs/02-media.md, rule 4). */
  audio: boolean;
}

/**
 * PTT binding. Desktop: global uiohook key/mouse codes. Web: DOM `KeyboardEvent.code`
 * or `Mouse<button>` (works only while the tab is focused, ADR-0015).
 */
/**
 * PTT binding. `key`/`mouse` codes are libuiohook codes (see shared/pttKeys.ts), `dom` is the
 * web fallback (`KeyboardEvent.code` / `Mouse<N>`). `mode` defaults to 'hold'.
 * `remap: 'caps-f18'` (macOS fallback without the HID listener): Caps Lock is remapped to F18 with
 * hidutil while Calaba runs, the binding listens to F18. `source` (informational): which hook
 * source delivered the key at capture — 'hid' = the macOS IOHIDManager listener (Caps Lock).
 */
export type { PttMode };

export type PttBinding =
  | { kind: 'key'; code: number; label: string; mode?: PttMode; remap?: 'caps-f18'; source?: KeySource }
  | { kind: 'mouse'; code: number; label: string; mode?: PttMode }
  | { kind: 'dom'; code: string; label: string; mode?: PttMode };

export interface PttStatus {
  active: boolean;
  binding: PttBinding | null;
  /** macOS: Accessibility / Input Monitoring trust; always true elsewhere. */
  trusted: boolean;
  error: string | null;
  /** macOS Caps Lock → F18 remap: 'active' while applied. */
  capsRemap: 'unsupported' | 'available' | 'active';
  /** Linux Wayland: no global key hooks (and the GlobalShortcuts portal has no Caps Lock). */
  wayland: boolean;
  /**
   * macOS IOHIDManager listener (physical Caps Lock): 'running'; 'denied' = no Input Monitoring;
   * 'restart' = granted since, reopen failed (restart Calab); 'off' until the hook starts.
   */
  hid: PttHidState;
}

export type PttHidState = 'unsupported' | 'off' | 'starting' | 'running' | 'denied' | 'restart' | 'error';

export interface PttEvent {
  down: boolean;
  /** Off without the release tail (toggle-off, gate reset); a hold key-up leaves it unset. */
  immediate?: boolean;
  /** Date.now() when main saw the key (debug: IPC + release latency). */
  at?: number;
}

/** main → renderer while a PTT capture is armed: the last raw key event (diagnostics line). */
export interface PttRawKey {
  code: number;
  rawcode: number;
  source: KeySource;
  down: boolean;
  /** Dropped as a duplicate of the other source (shared/keySource.ts). */
  dropped: boolean;
}

export type PrivacyPane = 'accessibility' | 'input-monitoring' | 'screen' | 'microphone' | 'camera';

export interface PermissionStatus {
  /** 'granted' | 'denied' | 'not-determined' | 'restricted' | 'n/a' */
  microphone: string;
  camera: string;
  screen: string;
  /** Accessibility trust (global PTT on macOS); true elsewhere. */
  accessibility: boolean;
  notifications: 'granted' | 'denied' | 'default' | 'n/a';
}

export interface ScreenAccess {
  /** systemPreferences.getMediaAccessStatus('screen'): 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown' | 'n/a' */
  status: string;
  /**
   * A probe capture returned real pixels. Only probed when `status` is 'granted': macOS may
   * report the grant while this process still cannot capture until it is relaunched.
   */
  canCapture: boolean;
}

export interface ProcessMetrics {
  /** % of one core (like ps/top), averaged since the previous sample. */
  rendererCpu: number | null;
  gpuCpu: number | null;
  mainCpu: number | null;
  rendererPid: number;
}
