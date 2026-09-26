import type {
  AppInfo,
  AppSettings,
  AuthSession,
  CaptureSelection,
  CaptureSource,
  DownloadArgs,
  LegalTexts,
  DownloadProgress,
  IpcResult,
  LoginArgs,
  LogoutReason,
  PowerEvent,
  PermissionStatus,
  PrivacyPane,
  ProcessMetrics,
  ScreenAccess,
  PttBinding,
  PttEvent,
  PttRawKey,
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
    /** Current update status (after a renderer reload). */
    updateStatus(): Promise<UpdateStatus>;
    /** «Перезапустить»: quit and install the downloaded update; false when none is downloaded. */
    installUpdate(): Promise<boolean>;
    log(level: 'info' | 'warn' | 'error', message: string): void;
    openExternal(url: string): Promise<void>;
    /** LICENSE, NOTICE and THIRD-PARTY-NOTICES.txt texts («О программе»). */
    legal(): Promise<LegalTexts>;
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
    /** Progress of downloads started with `download` (quarantined by Chromium's download manager). */
    onProgress(cb: (p: DownloadProgress) => void): Unsubscribe;
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
    /**
     * Resolves with the next key/mouse button pressed anywhere (global). Rejects on Esc,
     * `cancelCapture(id)`, a newer capture or after ~15 s. `id` identifies the caller (binder).
     */
    captureNext(id: number): Promise<PttBinding>;
    /** Disarms a pending `captureNext` started with the same `id` (the binder UI closed). */
    cancelCapture(id: number): void;
    status(): Promise<PttStatus>;
    onEvent(cb: (ev: PttEvent) => void): Unsubscribe;
    /** While a capture is armed: each raw key event seen by the hook (diagnostics line in the binder). */
    onRawKey(cb: (ev: PttRawKey) => void): Unsubscribe;
  };
  system: {
    openPrivacySettings(pane: PrivacyPane): Promise<void>;
    metrics(): Promise<ProcessMetrics>;
    /** OS permission statuses (onboarding, Settings → devices). */
    permissions(): Promise<PermissionStatus>;
    /** Ask the OS for microphone access (macOS prompt); resolves with the result. */
    requestMic(): Promise<boolean>;
    /** Screen Recording status and whether capture works in this process (no prompt). */
    screenAccess(): Promise<ScreenAccess>;
    /**
     * macOS: when not granted, makes a capture attempt (adds Calab to the Screen Recording list)
     * and opens that Privacy pane. Resolves with the status after the attempt.
     */
    requestScreenAccess(): Promise<ScreenAccess>;
    /** Quit and start the app again (a new Screen Recording grant needs it). */
    relaunch(): Promise<void>;
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
