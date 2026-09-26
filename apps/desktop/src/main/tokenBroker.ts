import type { LogoutReason } from '../shared/ipc';

/**
 * Token state machine of the desktop token broker (auth.ts), free of Electron so it is
 * unit-tested: single-flight refresh, which failures end the session and which are transient.
 *
 * - 2xx → new tokens (persisted);
 * - 401 → the session is gone: cleared, `onLoggedOut('expired')`;
 * - 409 → the server already rotated this refresh token for a request whose answer we never
 *   received (network cut mid-response). On desktop nobody else holds the token (single
 *   instance, single-flight here) and there is no cookie that could carry the new one, so a
 *   retry can never succeed — and a retry after the 30 s grace window counts as token reuse.
 *   Treated like 401 (review L1; the web client's 409 retry is correct there: cookie mode);
 * - network error / 5xx / 429 → transient: the session is kept, `null` is returned and the
 *   caller retries later. Never a logout (review H3).
 *
 * A refresh racing a logout / login / revoke never resurrects or overwrites the newer state.
 */

export interface Tokens {
  accessToken: string;
  accessExpiresAt: number; // ms epoch
  refreshToken: string;
  sessionId: string;
}

export interface TokensJson {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  sessionId: string;
}

export interface RefreshResponse {
  status: number;
  /** Parsed body of a 2xx answer. */
  tokens?: TokensJson;
  /** Error code of a non-2xx answer (for logs). */
  code?: string;
}

export interface BrokerDeps {
  /** POST /api/auth/refresh; throws on network errors. */
  refresh(serverUrl: string, refreshToken: string): Promise<RefreshResponse>;
  persist(serverUrl: string, tokens: Tokens | null): void;
  onLoggedOut(reason: LogoutReason): void;
  now?: () => number;
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
}

export const REFRESH_MARGIN_MS = 60_000;

export function toTokens(t: TokensJson): Tokens {
  return {
    accessToken: t.accessToken,
    accessExpiresAt: Date.parse(t.accessExpiresAt),
    refreshToken: t.refreshToken,
    sessionId: t.sessionId,
  };
}

export class TokenBroker {
  private tokens: Tokens | null = null;
  private server = '';
  private refreshing: Promise<Tokens | null> | null = null;

  constructor(private readonly deps: BrokerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get serverUrl(): string {
    return this.server;
  }

  get current(): Tokens | null {
    return this.tokens;
  }

  get hasSession(): boolean {
    return this.tokens !== null;
  }

  /** A new session (login / register / guest / restore from disk). */
  set(serverUrl: string, tokens: Tokens, persist = true): void {
    this.server = serverUrl;
    this.tokens = tokens;
    if (persist) this.deps.persist(this.server, tokens);
  }

  clear(reason: LogoutReason, notify: boolean): void {
    this.tokens = null;
    this.deps.persist(this.server, null);
    if (notify) this.deps.onLoggedOut(reason);
  }

  /** A valid access token (refreshed when it expires within a minute); null = none right now. */
  async getAccessToken(): Promise<string | null> {
    const t = this.tokens;
    if (!t) return null;
    if (t.accessExpiresAt - this.now() > REFRESH_MARGIN_MS) return t.accessToken;
    const next = await this.refreshOnce();
    if (next) return next.accessToken;
    // Refresh failed transiently, but the current token may still be valid for a few seconds.
    const still = this.tokens;
    return still && still.accessToken && still.accessExpiresAt - this.now() > 5_000 ? still.accessToken : null;
  }

  /** Forced refresh (gateway close 4004 / an API 401). */
  async forceRefresh(): Promise<string | null> {
    if (!this.tokens) return null;
    const t = await this.refreshOnce();
    return t?.accessToken ?? null;
  }

  refreshOnce(): Promise<Tokens | null> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<Tokens | null> {
    const current = this.tokens;
    if (!current) return null;
    let res: RefreshResponse;
    try {
      res = await this.deps.refresh(this.server, current.refreshToken);
    } catch (e) {
      this.deps.log?.warn('refresh network error', e);
      return null; // offline: keep the session, the caller retries later
    }
    // Logout / login / revoke happened while the request was in flight: theirs wins.
    if (this.tokens !== current) return this.tokens;
    if (res.status >= 200 && res.status < 300 && res.tokens) {
      this.tokens = toTokens(res.tokens);
      this.deps.persist(this.server, this.tokens);
      return this.tokens;
    }
    if (res.status === 401 || res.status === 409) {
      this.deps.log?.info('refresh rejected, session ended', res.status, res.code ?? '');
      this.clear('expired', true);
      return null;
    }
    this.deps.log?.warn('refresh failed (transient)', res.status, res.code ?? '');
    return null; // 5xx / rate limit: keep the session
  }
}
