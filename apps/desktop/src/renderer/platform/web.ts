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
import { AUTH_TIMEOUT_MS, refreshGate } from '../../shared/refreshGate';
import type { GuestJoin, Platform } from './types';

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
/** Single-flight refresh; a transient failure is reused for a few seconds (review N3). */
const refreshes = refreshGate(() => doRefresh());
const loggedOutListeners = new Set<(r: LogoutReason) => void>();

function applyTokens(t: TokensJson): void {
  access = { token: t.accessToken, exp: Date.parse(t.accessExpiresAt), sessionId: t.sessionId };
  if (t.refreshToken) bodyRefresh = t.refreshToken; // server without cookie mode
  refreshes.reset();
}

/** Bumped on every sign-out: a refresh answer that arrives later must not resurrect it. */
let epoch = 0;

function clear(reason: LogoutReason | null): void {
  epoch++;
  access = null;
  bodyRefresh = null;
  refreshes.reset();
  clearMediaCache(); // images of the previous account (review M10)
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
    // Bounded: a black-holed refresh runs inside the cross-tab Web Lock and would block every tab (review N3).
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', ...WEB_HEADER, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
}

/** 409 on /api/auth/refresh = another refresh of the same session won the race: just retry. */
const REFRESH_CONFLICT_RETRIES = 3;

/**
 * null = no token now. Transient failures (offline, 5xx, 429) keep the session — callers retry
 * (the gateway backs off); only a rejected refresh signs out, via `onLoggedOut` (review H3).
 */
async function doRefresh(): Promise<string | null> {
  const started = epoch;
  const run = async (attempt = 0): Promise<string | null> => {
    try {
      const res = await postAuth('/api/auth/refresh', bodyRefresh ? { refreshToken: bodyRefresh } : {});
      if (started !== epoch) return null; // signed out meanwhile
      // 409 = another tab rotated the cookie a moment ago: the cookie already holds the new token.
      if (res.status === 409 && attempt < REFRESH_CONFLICT_RETRIES) {
        await new Promise((r) => setTimeout(r, 150 + Math.round(Math.random() * 250)));
        return await run(attempt + 1);
      }
      if (res.ok) {
        const body = (await res.json()) as { tokens: TokensJson };
        if (started !== epoch) return null;
        applyTokens(body.tokens);
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
  return 'locks' in navigator ? navigator.locks.request('calaba-refresh', () => run()) : run();
}

function refreshOnce(): Promise<string | null> {
  return refreshes.run();
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

/** Guest account from a room link (ADR-0016): the server sets the refresh cookie like on login. */
async function guestJoin(code: string, nickname: string): Promise<IpcResult<GuestJoin>> {
  try {
    const res = await postAuth(`/api/room-invites/${encodeURIComponent(code)}/join`, { nickname, deviceName: deviceName() });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const data = (await res.json()) as { roomId: string; workspaceId: string; tokens?: TokensJson; me?: unknown };
    if (!data.tokens) return { ok: false, error: { code: 'ERROR_CODE_INTERNAL', message: 'no guest session in the response', status: res.status } };
    applyTokens(data.tokens);
    return {
      ok: true,
      data: {
        session: { serverUrl: location.origin, sessionId: data.tokens.sessionId, me: data.me },
        roomId: data.roomId,
        workspaceId: data.workspaceId,
      },
    };
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

/**
 * LRU of blob: URLs for authenticated media (review M10). Evicted blobs are revoked — before,
 * eviction only dropped the map entry and the blob stayed alive until the tab closed.
 * Consumers hold the URL string only (no release call), so the revoke waits a grace period:
 * an element that got the URL just before eviction has loaded it by then (a loaded <img> keeps
 * its decoded image after the revoke; a remount asks `mediaUrl` again and refetches).
 */
interface MediaEntry {
  url: Promise<string>;
  objectUrl: string | null;
  bytes: number;
  evicted: boolean;
}
const MEDIA_MAX_ENTRIES = 300;
const MEDIA_MAX_BYTES = 150 * 1024 * 1024;
const MEDIA_REVOKE_GRACE_MS = 60_000;
const mediaCache = new Map<string, MediaEntry>(); // Map order = LRU order (re-inserted on hit)
let mediaBytes = 0;

function evictMedia(path: string, e: MediaEntry, graceMs: number): void {
  if (mediaCache.get(path) === e) mediaCache.delete(path);
  if (e.evicted) return;
  e.evicted = true;
  const u = e.objectUrl;
  if (!u) return; // still loading: revoked when it resolves
  mediaBytes -= e.bytes;
  if (graceMs > 0) window.setTimeout(() => URL.revokeObjectURL(u), graceMs);
  else URL.revokeObjectURL(u);
}

function trimMedia(): void {
  while (mediaCache.size > 1 && (mediaCache.size > MEDIA_MAX_ENTRIES || mediaBytes > MEDIA_MAX_BYTES)) {
    const oldest = mediaCache.entries().next().value;
    if (!oldest) break;
    evictMedia(oldest[0], oldest[1], MEDIA_REVOKE_GRACE_MS);
  }
}

function clearMediaCache(): void {
  for (const [path, e] of [...mediaCache]) evictMedia(path, e, 0);
  mediaBytes = 0;
}

function mediaUrl(path: string): Promise<string> {
  const hit = mediaCache.get(path);
  if (hit) {
    mediaCache.delete(path);
    mediaCache.set(path, hit);
    return hit.url;
  }
  const e: MediaEntry = { url: Promise.resolve(''), objectUrl: null, bytes: 0, evicted: false };
  e.url = apiFetch(path).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const u = URL.createObjectURL(blob);
    if (e.evicted) {
      // Evicted (or signed out) while loading: the caller still gets a URL for a moment.
      window.setTimeout(() => URL.revokeObjectURL(u), MEDIA_REVOKE_GRACE_MS);
      return u;
    }
    e.objectUrl = u;
    e.bytes = blob.size;
    mediaBytes += blob.size;
    trimMedia();
    return u;
  });
  e.url.catch(() => {
    if (mediaCache.get(path) === e) mediaCache.delete(path);
  });
  mediaCache.set(path, e);
  trimMedia();
  return e.url;
}

// ---------------------------------------------------------------- PTT (focused tab only)

let binding: PttBinding | null = null;
let gate: PttGate | null = null;
const pttListeners = new Set<(e: PttEvent) => void>();
let capture: { id: number; resolve: (b: PttBinding) => void; reject: (e: Error) => void } | null = null;
const MAC = /Mac OS X|Macintosh/.test(navigator.userAgent);

function pttEmit(talking: boolean, immediate: boolean): void {
  for (const cb of pttListeners) cb({ down: talking, immediate, at: Date.now() });
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
  return { active: binding !== null, binding, trusted: true, error: null, capsRemap: 'unsupported', wayland: false, hid: 'unsupported' };
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
    locales: [...navigator.languages],
  };
}

const settings = (): AppSettings => ({ serverUrl: location.origin, updateUrl: '', autostart: false, autoUpdate: false, autoCheckUpdates: false });

/**
 * Links on the web: https://<domain>/join/<code> (workspace invite) and https://<domain>/r/<code>
 * (room link, ADR-0016), https://<domain>/dm/<id> (a DM, ADR-0020) — the same URLs the app shares. Handed on as the https link; the address
 * bar keeps the path while the link card is shown (docs/09 #53, services/linkLanding.ts).
 */
function takeDeepLink(): Promise<string | null> {
  const m = /^\/(join|r|dm)\/([A-Za-z0-9_-]{4,64})\/?$/.exec(location.pathname);
  if (!m?.[1] || !m[2]) return Promise.resolve(null);
  return Promise.resolve(`${location.origin}/${m[1]}/${m[2]}`);
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
    guestJoin,
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
      guestJoin,
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
      // Served next to the web client (copied by `pnpm build:web`).
      legal: async () => {
        const get = async (path: string): Promise<string> => {
          try {
            const r = await fetch(path);
            return r.ok ? await r.text() : '';
          } catch {
            return '';
          }
        };
        const [license, notice, commercial, thirdParty] = await Promise.all([
          get('/LICENSE.txt'),
          get('/NOTICE.txt'),
          get('/COMMERCIAL-LICENSE.txt'),
          get('/THIRD-PARTY-NOTICES.txt'),
        ]);
        return { license, notice, commercial, thirdParty };
      },
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
      updateStatus: () => Promise.resolve({ state: 'disabled' }),
      installUpdate: () => Promise.resolve(false),
      networkOnline: () => undefined,
      log: (level, message) => {
        (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(message);
      },
      openExternal: (url) => {
        if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
        return Promise.resolve();
      },
      attention: () => undefined,
      setTheme: () => undefined,
      setStrings: () => undefined,
    },
    tray: { setState: () => undefined, onAction: noop },
    files: { download, onProgress: noop, pathOf: (f) => f.name },
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
      captureNext: (id) =>
        new Promise<PttBinding>((resolve, reject) => {
          capture?.reject(new Error('superseded'));
          capture = { id, resolve, reject };
        }),
      cancelCapture: (id) => {
        // Only the binder that started the capture may cancel it (review N6).
        const c = capture;
        if (!c || c.id !== id) return;
        capture = null;
        c.reject(new Error('cancelled'));
      },
      status: () => Promise.resolve(pttStatus()),
      onEvent: (cb) => {
        pttListeners.add(cb);
        return () => pttListeners.delete(cb);
      },
      // No global hook in the browser: nothing to diagnose.
      onRawKey: () => () => undefined,
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
          camera: await q('camera'),
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
      idleSeconds: () => Promise.resolve(webIdleSeconds()),
      // The browser asks at getDisplayMedia() itself; the onboarding screen step is macOS desktop only.
      screenAccess: () => Promise.resolve({ status: 'n/a', canCapture: true }),
      requestScreenAccess: () => Promise.resolve({ status: 'n/a', canCapture: true }),
      relaunch: () => {
        window.location.reload();
        return Promise.resolve();
      },
    },
  };
}

// ---------------------------------------------------------------- AFK (web)

/**
 * A browser only sees input inside its own tab: activity = keyboard/pointer/wheel events here
 * and the tab becoming visible again. A hidden tab accumulates idle time.
 */
let lastInput = Date.now();
let idleTracking = false;

function webIdleSeconds(): number {
  if (!idleTracking) {
    idleTracking = true;
    const bump = (): void => {
      lastInput = Date.now();
    };
    for (const ev of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const) {
      window.addEventListener(ev, bump, { passive: true, capture: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') bump();
    });
  }
  return Math.floor((Date.now() - lastInput) / 1000);
}
