import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, net, safeStorage } from 'electron';
import log from 'electron-log/main';
import {
  IPC,
  type ApiErrorJson,
  type AuthSession,
  type IpcResult,
  type LoginArgs,
  type LogoutReason,
  type RegisterArgs,
} from '../shared/ipc';
import { getSettings, normalizeServerUrl, updateSettings } from './settings';

/**
 * Token broker (docs/04-data-model.md, "Auth").
 *
 * - The refresh token lives only in main, persisted with `safeStorage` (OS
 *   keychain / DPAPI / libsecret). If the OS offers no encryption it is kept
 *   in memory only — never written in plain text, never given to the renderer.
 * - The short-lived access token is refreshed here (single-flight, so several
 *   windows or parallel requests never race a rotation → reuse detection).
 */

interface Tokens {
  accessToken: string;
  accessExpiresAt: number; // ms epoch
  refreshToken: string;
  sessionId: string;
}

interface StoredSession {
  serverUrl: string;
  refreshToken: string;
  sessionId: string;
}

const REFRESH_MARGIN_MS = 60_000;

let tokens: Tokens | null = null;
let serverUrl = '';
let refreshing: Promise<Tokens | null> | null = null;

function storeFile(): string {
  return join(app.getPath('userData'), 'session.bin');
}

function persist(): void {
  if (!tokens) {
    rmSync(storeFile(), { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('safeStorage unavailable: refresh token kept in memory only (login required after restart)');
    return;
  }
  const data: StoredSession = { serverUrl, refreshToken: tokens.refreshToken, sessionId: tokens.sessionId };
  writeFileSync(storeFile(), safeStorage.encryptString(JSON.stringify(data)));
}

function loadStored(): StoredSession | null {
  try {
    if (!existsSync(storeFile()) || !safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(readFileSync(storeFile()))) as StoredSession;
  } catch (err) {
    log.warn('stored session unreadable, ignoring', err);
    return null;
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

function clearSession(reason: LogoutReason, notify: boolean): void {
  tokens = null;
  persist();
  if (notify) broadcast(IPC.authLoggedOut, reason);
}

interface TokensJson {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  sessionId: string;
}

function toTokens(t: TokensJson): Tokens {
  return {
    accessToken: t.accessToken,
    accessExpiresAt: Date.parse(t.accessExpiresAt),
    refreshToken: t.refreshToken,
    sessionId: t.sessionId,
  };
}

async function readError(res: Response): Promise<ApiErrorJson> {
  try {
    const body = (await res.json()) as Partial<ApiErrorJson>;
    return {
      code: body.code ?? 'ERROR_CODE_UNSPECIFIED',
      message: body.message ?? res.statusText,
      ...(body.field ? { field: body.field } : {}),
      status: res.status,
    };
  } catch {
    return { code: 'ERROR_CODE_UNSPECIFIED', message: res.statusText || `HTTP ${res.status}`, status: res.status };
  }
}

function networkError(err: unknown): ApiErrorJson {
  return { code: 'ERROR_CODE_UNAVAILABLE', message: err instanceof Error ? err.message : String(err), status: 0 };
}

async function postJson(base: string, path: string, body: unknown, access?: string): Promise<Response> {
  return net.fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function fetchMe(): Promise<unknown> {
  const t = await getAccessToken();
  if (!t) throw new Error('not authenticated');
  const res = await net.fetch(`${serverUrl}/api/me`, { headers: { Authorization: `Bearer ${t}` } });
  if (!res.ok) throw new Error(`GET /api/me: ${res.status}`);
  const body = (await res.json()) as { me: unknown };
  return body.me;
}

function deviceName(): string {
  return `${hostname()} (${process.platform})`;
}

async function doRefresh(): Promise<Tokens | null> {
  const current = tokens;
  if (!current) return null;
  try {
    const res = await postJson(serverUrl, '/api/auth/refresh', { refreshToken: current.refreshToken });
    if (res.ok) {
      const body = (await res.json()) as { tokens: TokensJson };
      tokens = toTokens(body.tokens);
      persist();
      return tokens;
    }
    const err = await readError(res);
    if (res.status === 401) {
      log.info('refresh rejected, session ended', err.code);
      clearSession('expired', true);
      return null;
    }
    log.warn('refresh failed', err);
    return null; // transient (5xx / rate limit): keep the session, caller retries later
  } catch (e) {
    log.warn('refresh network error', e);
    return null;
  }
}

function refreshOnce(): Promise<Tokens | null> {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** A valid access token (refreshed if it expires within a minute), or null when logged out / offline. */
export async function getAccessToken(): Promise<string | null> {
  if (!tokens) return null;
  if (tokens.accessExpiresAt - Date.now() > REFRESH_MARGIN_MS) return tokens.accessToken;
  const t = await refreshOnce();
  return t?.accessToken ?? null;
}

/** Forced refresh (gateway close 4004 / an API 401). */
export async function forceRefresh(): Promise<string | null> {
  if (!tokens) return null;
  const t = await refreshOnce();
  return t?.accessToken ?? null;
}

export function currentServerUrl(): string {
  return serverUrl || getSettings().serverUrl;
}

export async function restore(): Promise<AuthSession | null> {
  const stored = loadStored();
  if (!stored) return null;
  serverUrl = stored.serverUrl;
  tokens = { accessToken: '', accessExpiresAt: 0, refreshToken: stored.refreshToken, sessionId: stored.sessionId };
  const t = await refreshOnce();
  if (!t) {
    // Either rejected (already cleared) or offline: stay logged in only if we still hold tokens.
    if (!tokens) return null;
    throw new Error('offline');
  }
  const me = await fetchMe();
  return { serverUrl, sessionId: t.sessionId, me };
}

async function authenticate(
  args: LoginArgs,
  path: string,
  body: Record<string, unknown>,
): Promise<IpcResult<AuthSession>> {
  const base = normalizeServerUrl(args.serverUrl);
  try {
    const res = await postJson(base, path, body);
    if (!res.ok) return { ok: false, error: await readError(res) };
    const data = (await res.json()) as { tokens: TokensJson; me: unknown };
    serverUrl = base;
    tokens = toTokens(data.tokens);
    persist();
    if (getSettings().serverUrl !== base) updateSettings({ serverUrl: base });
    return { ok: true, data: { serverUrl: base, sessionId: tokens.sessionId, me: data.me } };
  } catch (e) {
    return { ok: false, error: networkError(e) };
  }
}

export function login(args: LoginArgs): Promise<IpcResult<AuthSession>> {
  return authenticate(args, '/api/auth/login', {
    email: args.email,
    password: args.password,
    deviceName: deviceName(),
  });
}

export function register(args: RegisterArgs): Promise<IpcResult<AuthSession>> {
  return authenticate(args, '/api/auth/register', {
    email: args.email,
    password: args.password,
    displayName: args.displayName,
    inviteCode: args.inviteCode,
    deviceName: deviceName(),
  });
}

export async function logout(allSessions: boolean): Promise<void> {
  const access = await getAccessToken();
  if (access) {
    try {
      await postJson(serverUrl, '/api/auth/logout', { allSessions }, access);
    } catch (e) {
      log.warn('logout request failed (session cleared locally anyway)', e);
    }
  }
  clearSession('logout', true);
}

/** Called when the gateway reports the session revoked (4010). */
export function revoked(): void {
  clearSession('revoked', false);
}
