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
  type RegisterArgs,
} from '../shared/ipc';
import { INSECURE_SERVER_CODE, serverUrlProblem } from '../shared/serverUrl';
import { AUTH_TIMEOUT_MS } from '../shared/refreshGate';
import { getSettings, normalizeServerUrl, updateSettings } from './settings';
import { TokenBroker, toTokens, type Tokens, type TokensJson } from './tokenBroker';

/**
 * Token broker (docs/04-data-model.md, "Auth").
 *
 * - The refresh token lives only in main, persisted with `safeStorage` (OS
 *   keychain / DPAPI / libsecret). If the OS offers no encryption it is kept
 *   in memory only — never written in plain text, never given to the renderer.
 * - The short-lived access token is refreshed here (single-flight, so several
 *   windows or parallel requests never race a rotation → reuse detection).
 */

interface StoredSession {
  serverUrl: string;
  refreshToken: string;
  sessionId: string;
}

/** CALABA_ALLOW_INSECURE_HTTP=1: accept a plain-http server outside loopback (LAN tests only). */
const ALLOW_INSECURE = process.env['CALABA_ALLOW_INSECURE_HTTP'] === '1';

function storeFile(): string {
  return join(app.getPath('userData'), 'session.bin');
}

function persist(serverUrl: string, tokens: Tokens | null): void {
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

/** Token state + refresh policy (tokenBroker.ts: single-flight, 401/409 end, rest transient). */
const broker = new TokenBroker({
  refresh: async (base, refreshToken) => {
    const res = await postJson(base, '/api/auth/refresh', { refreshToken });
    if (res.ok) return { status: res.status, tokens: ((await res.json()) as { tokens: TokensJson }).tokens };
    return { status: res.status, code: (await readError(res)).code };
  },
  persist,
  onLoggedOut: (reason) => broadcast(IPC.authLoggedOut, reason),
  log,
});

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
    // Bounded: a black-holed refresh would otherwise hang every API call behind the broker (review N3).
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
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
  const res = await net.fetch(`${broker.serverUrl}/api/me`, {
    headers: { Authorization: `Bearer ${t}` },
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET /api/me: ${res.status}`);
  const body = (await res.json()) as { me: unknown };
  return body.me;
}

function deviceName(): string {
  return `${hostname()} (${process.platform})`;
}

/** A valid access token (refreshed if it expires within a minute); null = none right now (logged out / offline). */
export function getAccessToken(): Promise<string | null> {
  return broker.getAccessToken();
}

/** Forced refresh (gateway close 4004 / an API 401); null = could not refresh now. */
export function forceRefresh(): Promise<string | null> {
  return broker.forceRefresh();
}

export function currentServerUrl(): string {
  return broker.serverUrl || getSettings().serverUrl;
}

function insecure(base: string): IpcResult<never> | null {
  const problem = serverUrlProblem(base, ALLOW_INSECURE);
  if (!problem) return null;
  return {
    ok: false,
    error: {
      code: problem === 'insecure' ? INSECURE_SERVER_CODE : 'ERROR_CODE_INVALID_ARGUMENT',
      message: problem === 'insecure' ? 'plain http is allowed only for localhost' : 'invalid server URL',
      field: 'serverUrl',
      status: 0,
    },
  };
}

export async function restore(): Promise<AuthSession | null> {
  const stored = loadStored();
  if (!stored) return null;
  if (insecure(stored.serverUrl)) {
    // A session saved for a plain-http server (before review L11): don't send its token again.
    log.warn('stored session for an insecure server URL dropped', stored.serverUrl);
    broker.clear('logout', false);
    return null;
  }
  broker.set(stored.serverUrl, { accessToken: '', accessExpiresAt: 0, refreshToken: stored.refreshToken, sessionId: stored.sessionId }, false);
  const t = await broker.refreshOnce();
  if (!t) {
    // Either rejected (the broker cleared the session) or offline (session kept).
    if (!broker.hasSession) return null;
    throw new Error('offline');
  }
  const me = await fetchMe();
  return { serverUrl: broker.serverUrl, sessionId: t.sessionId, me };
}

async function authenticate(
  args: LoginArgs,
  path: string,
  body: Record<string, unknown>,
): Promise<IpcResult<AuthSession>> {
  const base = normalizeServerUrl(args.serverUrl);
  const bad = insecure(base);
  if (bad) return bad;
  try {
    const res = await postJson(base, path, body);
    if (!res.ok) return { ok: false, error: await readError(res) };
    const data = (await res.json()) as { tokens: TokensJson; me: unknown };
    const tokens = toTokens(data.tokens);
    broker.set(base, tokens);
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

/**
 * Guest sign-in from a room link (ADR-0016, `calaba://r/<code>` or a pasted https link):
 * POST /api/room-invites/{code}/join {nickname} without a session → the server creates a
 * guest account and returns tokens like a login; the refresh token is kept in main as usual.
 */
export async function guestJoin(code: string, nickname: string): Promise<IpcResult<{ session: AuthSession; roomId: string; workspaceId: string }>> {
  const base = normalizeServerUrl(currentServerUrl());
  const bad = insecure(base);
  if (bad) return bad;
  try {
    const res = await postJson(base, `/api/room-invites/${encodeURIComponent(code)}/join`, { nickname, deviceName: deviceName() });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const data = (await res.json()) as { roomId: string; workspaceId: string; tokens?: TokensJson; me?: unknown };
    if (!data.tokens) return { ok: false, error: { code: 'ERROR_CODE_INTERNAL', message: 'no guest session in the response', status: res.status } };
    const tokens = toTokens(data.tokens);
    broker.set(base, tokens);
    const me = data.me ?? (await fetchMe());
    return { ok: true, data: { session: { serverUrl: base, sessionId: tokens.sessionId, me }, roomId: data.roomId, workspaceId: data.workspaceId } };
  } catch (e) {
    return { ok: false, error: networkError(e) };
  }
}

export async function logout(allSessions: boolean): Promise<void> {
  const access = await getAccessToken();
  if (access) {
    try {
      await postJson(broker.serverUrl, '/api/auth/logout', { allSessions }, access);
    } catch (e) {
      log.warn('logout request failed (session cleared locally anyway)', e);
    }
  }
  broker.clear('logout', true);
}

/** Called when the gateway reports the session revoked (4010). */
export function revoked(): void {
  broker.clear('revoked', false);
}
