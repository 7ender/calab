import type {
  ApiErrorJson,
  AppInfo,
  AppSettings,
  AuthSession,
  IpcResult,
  LoginArgs,
  LogoutReason,
  PowerEvent,
  PttBinding,
  PttEvent,
  PttStatus,
  RegisterArgs,
} from '../../shared/ipc';
import { PttGate } from '../../shared/pttGate';
import { mouseName } from '../../shared/pttKeys';
import type { Platform } from './types';

/**
 * Web platform (ADR-0015). Same origin as the API (`https://app.<domain>`):
 * - the refresh token lives in an HttpOnly `SameSite=Strict` cookie set by the server
 *   (requests carry `X-Client: web`); the access token only in memory;
 * - if the server answers with the refresh token in the body (no cookie mode), it is
 *   kept in memory only (never in storage) — a reload then asks to log in again;
 * - refreshes are serialised across tabs with the Web Locks API, so two tabs never race
 *   a rotation (reuse detection would revoke the session).
 */

const WEB_HEADER = { 'X-Client': 'web' } as const;
const REFRESH_MARGIN_MS = 60_000;

interface TokensJson {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken?: string;
  sessionId: string;
}

let access: { token: string; exp: number; sessionId: string } | null = null;
let bodyRefresh: string | null = null;
let refreshing: Promise<string | null> | null = null;
const loggedOutListeners = new Set<(r: LogoutReason) => void>();

function applyTokens(t: TokensJson): void {
  access = { token: t.accessToken, exp: Date.parse(t.accessExpiresAt), sessionId: t.sessionId };
  if (t.refreshToken) bodyRefresh = t.refreshToken; // server without cookie mode
}

function clear(reason: LogoutReason | null): void {
  access = null;
  bodyRefresh = null;
  if (reason) for (const cb of loggedOutListeners) cb(reason);
}

async function readError(res: Response): Promise<ApiErrorJson> {
  try {
    const b = (await res.json()) as Partial<ApiErrorJson>;
    return { code: b.code ?? 'ERROR_CODE_UNSPECIFIED', message: b.message ?? res.statusText, ...(b.field ? { field: b.field } : {}), status: res.status };
  } catch {
    return { code: 'ERROR_CODE_UNSPECIFIED', message: res.statusText || `HTTP ${res.status}`, status: res.status };
  }
}

function postAuth(path: string, body: unknown, bearer?: string): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...WEB_HEADER, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function doRefresh(): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    try {
      const res = await postAuth('/api/auth/refresh', bodyRefresh ? { refreshToken: bodyRefresh } : {});
      if (res.ok) {
        applyTokens(((await res.json()) as { tokens: TokensJson }).tokens);
        return access?.token ?? null;
      }
      if (res.status === 401 || res.status === 400 || res.status === 403) {
        const hadSession = access !== null;
        clear(hadSession ? 'expired' : null);
        return null;
      }
      return null; // 5xx / rate limit: keep the session, retry later
    } catch {
      return null; // offline
    }
  };
  // One refresh at a time across tabs (they share the cookie).
  // Web Locks: all current browsers; the guard keeps very old Safari working (single-tab refresh).
  return 'locks' in navigator ? navigator.locks.request('calaba-refresh', run) : run();
}

function refreshOnce(): Promise<string | null> {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function accessToken(): Promise<string | null> {
  if (access && access.exp - Date.now() > REFRESH_MARGIN_MS) return access.token;
  return refreshOnce();
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /YaBrowser\//.test(ua) ? 'Yandex' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser} (web)`;
}

async function authenticate(path: string, body: Record<string, unknown>): Promise<IpcResult<AuthSession>> {
  try {
    const res = await postAuth(path, { ...body, deviceName: deviceName() });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const data = (await res.json()) as { tokens: TokensJson; me: unknown };
    applyTokens(data.tokens);
    return { ok: true, data: { serverUrl: location.origin, sessionId: data.tokens.sessionId, me: data.me } };
  } catch (e) {
    return { ok: false, error: { code: 'ERROR_CODE_UNAVAILABLE', message: e instanceof Error ? e.message : String(e), status: 0 } };
  }
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const go = async (token: string | null): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(path, { ...init, headers, credentials: 'same-origin' });
  };
  let res = await go(await accessToken());
  // Retry once after a forced refresh if the body can be replayed (not a stream).
  const replayable = init.body === undefined || init.body === null || typeof init.body === 'string';
  if (res.status === 401 && replayable && access) {
    const t = await refreshOnce();
    if (t) res = await go(t);
  }
  return res;
}

// ---------------------------------------------------------------- media URLs (blob cache)

const mediaCache = new Map<string, Promise<string>>();

function mediaUrl(path: string): Promise<string> {
  let p = mediaCache.get(path);
  if (!p) {
    p = apiFetch(path).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return URL.createObjectURL(await res.blob());
    });
    p.catch(() => mediaCache.delete(path));
    if (mediaCache.size > 500) {
      const first = mediaCache.keys().next().value;
      if (first) mediaCache.delete(first);
    }
    mediaCache.set(path, p);
  }
  return p;
}

// ---------------------------------------------------------------- PTT (focused tab only)

let binding: PttBinding | null = null;
let gate: PttGate | null = null;
const pttListeners = new Set<(e: PttEvent) => void>();
let capture: { resolve: (b: PttBinding) => void; reject: (e: Error) => void } | null = null;
const MAC = /Mac OS X|Macintosh/.test(navigator.userAgent);

function pttEmit(talking: boolean): void {
  for (const cb of pttListeners) cb({ down: talking });
}

/** Browsers on macOS report Caps Lock as lock-state flips (down = on, up = off): toggle only. */
function isLockCode(code: string): boolean {
  return MAC && code === 'CapsLock';
}

function setWebBinding(b: PttBinding | null): void {
  gate?.reset();
  binding = b?.kind === 'dom' ? b : null;
  gate = binding ? new PttGate(isLockCode(binding.code) ? 'toggle' : (binding.mode ?? 'hold'), isLockCode(binding.code), pttEmit) : null;
}

function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

function keyLabel(e: KeyboardEvent): string {
  if (e.code === 'Space') return 'Space';
  if (e.code === 'CapsLock') return '⇪ Caps Lock';
  return e.code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
}

window.addEventListener('keydown', (e) => {
  if (capture) {
    e.preventDefault();
    const c = capture;
    capture = null;
    if (e.code === 'Escape') c.reject(new Error('cancelled'));
    else c.resolve({ kind: 'dom', code: e.code, label: keyLabel(e), mode: isLockCode(e.code) ? 'toggle' : 'hold' });
    return;
  }
  if (binding?.kind === 'dom' && binding.code === e.code && !isTyping(e)) {
    e.preventDefault();
    gate?.input(true);
  }
});
window.addEventListener('keyup', (e) => {
  if (binding?.kind === 'dom' && binding.code === e.code) gate?.input(false);
});
window.addEventListener('mousedown', (e) => {
  // DOM buttons: 1 middle, 3 back, 4 forward (uiohook numbering is +1).
  const code = `Mouse${e.button}`;
  if (capture && (e.button === 1 || e.button >= 3)) {
    const c = capture;
    capture = null;
    c.resolve({ kind: 'dom', code, label: mouseName(e.button + 1), mode: 'hold' });
    return;
  }
  if (binding?.kind === 'dom' && binding.code === code) gate?.input(true);
});
window.addEventListener('mouseup', (e) => {
  if (binding?.kind === 'dom' && binding.code === `Mouse${e.button}`) gate?.input(false);
});
// Losing focus releases a held key (keyup never arrives in another app); a toggle stays.
window.addEventListener('blur', () => {
  if (binding && !isLockCode(binding.code as string) && (binding.mode ?? 'hold') === 'hold') gate?.reset();
});

function pttStatus(): PttStatus {
  return { active: binding !== null, binding, trusted: true, error: null, capsRemap: 'unsupported', wayland: false };
}

// ---------------------------------------------------------------- downloads

async function download(args: { fileId: string; name: string }): Promise<string> {
  const res = await apiFetch(`/api/files/${args.fileId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = args.name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return args.name;
}

// ---------------------------------------------------------------- app

function info(): AppInfo {
  const chrome = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '';
  return {
    version: import.meta.env.VITE_APP_VERSION ?? '0.0.0',
    platform: 'web',
    hostname: location.host,
    electron: '',
    chrome,
    packaged: true,
    fakeMedia: false,
    forceRelay: false,
    visualTest: new URLSearchParams(location.search).has('visual-test'),
    // Browsers can offer tab/system audio in their own picker; own-audio exclusion is not guaranteed.
    systemAudioLoopback: 'experimental',
    micAccess: 'n/a',
    screenAccess: 'n/a',
  };
}

const settings = (): AppSettings => ({ serverUrl: location.origin, updateUrl: '', autostart: false });

/** Invite links on the web: https://<domain>/join/<code> (the same URL the app shares). */
function takeDeepLink(): Promise<string | null> {
  const m = /^\/join\/([A-Za-z0-9_-]{4,64})\/?$/.exec(location.pathname);
  if (!m?.[1]) return Promise.resolve(null);
  history.replaceState(null, '', '/');
  return Promise.resolve(`calaba://join/${m[1]}`);
}

const noop = (): (() => void) => () => undefined;

export function createWebPlatform(): Platform {
  return {
    kind: 'web',
    apiBase: '',
    apiFetch,
    authHeaders: async (): Promise<Record<string, string>> => {
      const t = await accessToken();
      return t ? { Authorization: `Bearer ${t}` } : {};
    },
    mediaUrl,
    directMedia: false,
    auth: {
      restore: async () => {
        const t = await refreshOnce();
        if (!t) {
          if (!navigator.onLine) throw new Error('offline');
          return null;
        }
        const res = await apiFetch('/api/me');
        if (!res.ok) return null;
        const body = (await res.json()) as { me: unknown };
        return { serverUrl: location.origin, sessionId: access?.sessionId ?? '', me: body.me };
      },
      login: (a: LoginArgs) => authenticate('/api/auth/login', { email: a.email, password: a.password }),
      register: (a: RegisterArgs) =>
        authenticate('/api/auth/register', { email: a.email, password: a.password, displayName: a.displayName, inviteCode: a.inviteCode }),
      logout: async (allSessions) => {
        const t = access?.token;
        try {
          await postAuth('/api/auth/logout', { allSessions, ...(bodyRefresh ? { refreshToken: bodyRefresh } : {}) }, t);
        } catch {
          // cleared locally anyway
        }
        clear('logout');
      },
      accessToken,
      forceRefresh: () => (access || bodyRefresh ? refreshOnce() : Promise.resolve(null)),
      revoked: () => {
        clear(null);
        return Promise.resolve();
      },
      onLoggedOut: (cb) => {
        loggedOutListeners.add(cb);
        return () => loggedOutListeners.delete(cb);
      },
    },
    app: {
      info: () => Promise.resolve(info()),
      getSettings: () => Promise.resolve(settings()),
      setSettings: () => Promise.resolve(settings()),
      takeDeepLink,
      onDeepLink: noop,
      onPower: (cb: (e: PowerEvent) => void) => {
        const online = (): void => cb('resume');
        window.addEventListener('online', online);
        return () => window.removeEventListener('online', online);
      },
      checkUpdates: () => Promise.resolve({ state: 'disabled' }),
      onUpdateStatus: noop,
      log: (level, message) => {
        (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(message);
      },
      openExternal: (url) => {
        if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
        return Promise.resolve();
      },
      attention: () => undefined,
      setTheme: () => undefined,
    },
    tray: { setState: () => undefined, onAction: noop },
    files: { download, pathOf: (f) => f.name },
    capture: {
      // The browser shows its own picker on getDisplayMedia().
      listSources: () => Promise.resolve([]),
      selectSource: () => Promise.resolve(),
    },
    ptt: {
      setBinding: (b) => {
        setWebBinding(b);
        return Promise.resolve(pttStatus());
      },
      captureNext: () =>
        new Promise<PttBinding>((resolve, reject) => {
          capture?.reject(new Error('superseded'));
          capture = { resolve, reject };
        }),
      status: () => Promise.resolve(pttStatus()),
      onEvent: (cb) => {
        pttListeners.add(cb);
        return () => pttListeners.delete(cb);
      },
    },
    system: {
      openPrivacySettings: () => Promise.resolve(),
      metrics: () => Promise.resolve({ rendererCpu: null, gpuCpu: null, mainCpu: null, rendererPid: 0 }),
      permissions: async () => {
        const q = async (name: string): Promise<string> => {
          try {
            const s = await navigator.permissions.query({ name: name as PermissionName });
            return s.state === 'prompt' ? 'not-determined' : s.state;
          } catch {
            return 'n/a';
          }
        };
        return {
          microphone: await q('microphone'),
          screen: 'n/a',
          accessibility: true,
          notifications: typeof Notification === 'undefined' ? 'n/a' : Notification.permission,
        };
      },
      requestMic: async () => {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach((t) => t.stop());
          return true;
        } catch {
          return false;
        }
      },
    },
  };
}
