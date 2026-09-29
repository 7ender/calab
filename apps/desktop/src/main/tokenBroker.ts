import type { LogoutReason } from '../shared/ipc';
import { logoutReasonFromRefresh } from '../shared/logoutReason';
import { refreshGate } from '../shared/refreshGate';

/**
 * Token state machine of the desktop token broker (auth.ts), free of Electron so it is
 * unit-tested: single-flight refresh, which failures end the session and which are transient.
 *
 * - 2xx → new tokens (persisted);
 * - 401 → the session is gone: cleared, `onLoggedOut(reason)` with the server's reason
 *   (shared/logoutReason.ts: SESSION_REVOKED/REUSE → 'reset', other revocations → 'revoked',
 *   an unknown / expired session → 'expired');
 * - 409 → the previous refresh token while the new one is unused, but the rotation could not be
 *   replayed (it predates the server's replay seal). Normally a retry of a refresh whose answer
 *   was lost (network cut mid-response, a stuck connection, the app quit for an update) gets
 *   the same new token pair again (200) for as long as the new token is unused, however late
 *   (docs/04 «Auth», docs/09 #89, #123). Retried once right away; a second 409 ends the session
 *   like 401 (the stale token cannot succeed);
 * - network error (incl. the AUTH_TIMEOUT_MS abort) → retried once at once over a fresh
 *   connection (`fresh: true`: auth.ts drops the pooled sockets — a stalled keep-alive
 *   connection must not eat the retry too); still failing → transient;
 * - network error / 5xx / 429 → transient: the session is kept, `null` is returned and the
 *   caller retries later — however long the outage lasts. Never a logout (review H3). The next
 *   attempt presents the same (previous) token: the server answers with the pair it already
 *   issued. A transient failure is reused for a few seconds (shared/refreshGate.ts) so an
 *   outage does not turn every API call into a refresh POST (review N3).
 *
 * Nothing is persisted before the answer arrives: a refresh interrupted by quit / update
 * leaves the previous refresh token on disk, and the next start retries it (restore() in
 * auth.ts) — while the new token is unused the server answers with the pair it already issued.
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
  /** Error code of a non-2xx answer. */
  code?: string;
  /** ApiError.reason of a non-2xx answer (SESSION_REVOKED: why). */
  reason?: string;
}

export interface BrokerDeps {
  /**
   * POST /api/auth/refresh; throws on network errors (and on the AUTH_TIMEOUT_MS abort).
   * `fresh`: over a new connection, not a pooled one (the retry after a network error).
   */
  refresh(serverUrl: string, refreshToken: string, fresh?: boolean): Promise<RefreshResponse>;
  persist(serverUrl: string, tokens: Tokens | null): void;
  onLoggedOut(reason: LogoutReason): void;
  now?: () => number;
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
}

export const REFRESH_MARGIN_MS = 60_000;

/** Pause before the single retry after a 409 (the server's replay entry may lag a moment). */
export const CONFLICT_RETRY_MS = 250;

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
  /** The refresh request running now (for settled()). */
  private inFlight: Promise<unknown> | null = null;
  private readonly gate = refreshGate(() => this.doRefresh(), {
    now: () => this.now(),
    // null with the session still there = transient (offline / 5xx); a cleared session is not cached.
    isTransient: () => this.tokens !== null,
  });

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
    this.gate.reset();
    if (persist) this.deps.persist(this.server, tokens);
  }

  clear(reason: LogoutReason, notify: boolean): void {
    this.tokens = null;
    this.gate.reset();
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
    return this.gate.run();
  }

  /** Resolves once no refresh is in flight (or after `timeoutMs`): quit / update waits for it. */
  settled(timeoutMs: number): Promise<void> {
    const running = this.inFlight;
    if (!running) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      void running.finally(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private doRefresh(): Promise<Tokens | null> {
    const p = this.refreshNow();
    this.inFlight = p;
    void p.finally(() => {
      if (this.inFlight === p) this.inFlight = null;
    });
    return p;
  }

  /**
   * One refresh POST; a network error (timeout included) is retried once at once over a fresh
   * connection. Throws when both fail. Logged with the elapsed time and the attempt number.
   */
  private async request(refreshToken: string): Promise<RefreshResponse> {
    const t0 = this.now();
    try {
      return await this.deps.refresh(this.server, refreshToken, false);
    } catch (e) {
      this.deps.log?.warn('refresh network error', { attempt: 1, elapsedMs: this.now() - t0 }, e);
    }
    const t1 = this.now();
    try {
      return await this.deps.refresh(this.server, refreshToken, true);
    } catch (e) {
      this.deps.log?.warn('refresh network error', { attempt: 2, fresh: true, elapsedMs: this.now() - t1 }, e);
      throw e;
    }
  }

  private async refreshNow(): Promise<Tokens | null> {
    const current = this.tokens;
    if (!current) return null;
    let res: RefreshResponse;
    try {
      res = await this.request(current.refreshToken);
      if (res.status === 409 && this.tokens === current) {
        // The rotation of this token could not be replayed right now: one more try.
        this.deps.log?.info('refresh 409, retrying once', res.code ?? '');
        await new Promise((r) => setTimeout(r, CONFLICT_RETRY_MS));
        if (this.tokens !== current) return this.tokens;
        res = await this.request(current.refreshToken);
      }
    } catch {
      return null; // offline: keep the session, the caller retries later (logged in request())
    }
    // Logout / login / revoke happened while the request was in flight: theirs wins.
    if (this.tokens !== current) return this.tokens;
    if (res.status >= 200 && res.status < 300 && res.tokens) {
      this.tokens = toTokens(res.tokens);
      this.deps.persist(this.server, this.tokens);
      return this.tokens;
    }
    if (res.status === 401 || res.status === 409) {
      this.deps.log?.info('refresh rejected, session ended', res.status, res.code ?? '', res.reason ?? '');
      this.clear(res.status === 401 ? logoutReasonFromRefresh(res.code, res.reason) : 'expired', true);
      return null;
    }
    this.deps.log?.warn('refresh failed (transient)', res.status, res.code ?? '');
    return null; // 5xx / rate limit: keep the session
  }
}
