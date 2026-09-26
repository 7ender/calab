import type {
  AppInfo,
  AppSettings,
  AuthSession,
  CaptureSelection,
  CaptureSource,
  DownloadArgs,
  IpcResult,
  LoginArgs,
  LogoutReason,
  PowerEvent,
  PermissionStatus,
  PrivacyPane,
  ProcessMetrics,
  PttBinding,
  PttEvent,
  PttStatus,
  RegisterArgs,
  TrayAction,
  TrayState,
  UpdateStatus,
} from '../shared/ipc';

type Unsubscribe = () => void;

/** API exposed to the renderer as `window.calaba` (see src/preload/index.ts). */
export interface CalabaApi {
  auth: {
    /** Restores the stored session (refresh token in OS keychain). Rejects with 'offline' when the server is unreachable. */
    restore(): Promise<AuthSession | null>;
    login(args: LoginArgs): Promise<IpcResult<AuthSession>>;
    register(args: RegisterArgs): Promise<IpcResult<AuthSession>>;
    /** Guest sign-in by a room link (ADR-0016): creates a guest account, keeps its session like a login. */
    guestJoin(code: string, nickname: string): Promise<IpcResult<{ session: AuthSession; roomId: string; workspaceId: string }>>;
    logout(allSessions: boolean): Promise<void>;
    /** Fresh access JWT for the gateway IDENTIFY (null = logged out / offline). */
    accessToken(): Promise<string | null>;
    /** Forces a refresh after gateway close 4004; null = session is gone. */
    forceRefresh(): Promise<string | null>;
    /** Gateway close 4010: drop the local session without calling the server. */
    revoked(): Promise<void>;
    onLoggedOut(cb: (reason: LogoutReason) => void): Unsubscribe;
  };
  app: {
    info(): Promise<AppInfo>;
    getSettings(): Promise<AppSettings>;
    setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
    takeDeepLink(): Promise<string | null>;
    onDeepLink(cb: (url: string) => void): Unsubscribe;
    onPower(cb: (ev: PowerEvent) => void): Unsubscribe;
    checkUpdates(): Promise<UpdateStatus>;
    onUpdateStatus(cb: (s: UpdateStatus) => void): Unsubscribe;
    log(level: 'info' | 'warn' | 'error', message: string): void;
    openExternal(url: string): Promise<void>;
    /** Bounce the dock / flash the taskbar when the window is not focused. */
    attention(): void;
    setTheme(theme: 'dark' | 'light' | 'system'): void;
  };
  tray: {
    setState(s: TrayState): void;
    onAction(cb: (a: TrayAction) => void): Unsubscribe;
  };
  files: {
    /** Saves an attachment to ~/Downloads, reveals it, resolves with the path. */
    download(args: DownloadArgs): Promise<string>;
    /** Absolute path of a dropped/picked File (for display only). */
    pathOf(file: File): string;
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
    onEvent(cb: (ev: PttEvent) => void): Unsubscribe;
  };
  system: {
    openPrivacySettings(pane: PrivacyPane): Promise<void>;
    metrics(): Promise<ProcessMetrics>;
    /** OS permission statuses (onboarding, Settings → devices). */
    permissions(): Promise<PermissionStatus>;
    /** Ask the OS for microphone access (macOS prompt); resolves with the result. */
    requestMic(): Promise<boolean>;
    /**
     * Seconds without keyboard/mouse input. Desktop: system-wide (powerMonitor, no permission
     * needed); web: input inside this tab only.
     */
    idleSeconds(): Promise<number>;
  };
}

declare global {
  interface Window {
    calaba: CalabaApi;
  }
}
