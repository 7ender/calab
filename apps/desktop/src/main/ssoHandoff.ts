import { createHash, randomBytes } from 'node:crypto';

export const SSO_PENDING_TTL_MS = 5 * 60_000;
export const SSO_MAX_PENDING = 8;
const MAX_SEEN_FLOWS = 64;
const BROWSER_START_PATH = '/api/auth/sso/browser-start';

/** Local main-process context, not a backend or IPC DTO. */
export interface SsoHandoffContext {
  serverOrigin: string;
  workspaceId: string;
  purpose: 'login' | 'step_up' | 'link' | 'test';
}

export interface SsoChallenge {
  attemptId: string;
  challenge: string;
  method: 'S256';
  expiresAt: number;
}

export interface SsoExchange extends SsoHandoffContext {
  flowId: string;
  ticket: string;
  verifier: string;
  signal: AbortSignal;
}

export interface SsoHandoffDeps {
  /** Main only: adapt generated DTOs here; honor signal before committing any auth state. */
  exchange(request: SsoExchange): Promise<void>;
  openExternal(url: string): Promise<void>;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
}

interface Pending {
  context: SsoHandoffContext;
  verifier: string;
  expiresAt: number;
  flowId?: string;
  consumed: boolean;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

/** Quarantine the reserved authority even when the callback itself is malformed. */
export function isSsoDeepLink(raw: string): boolean {
  const match = /^calaba?:\/\/([^/?#]*)/i.exec(raw.replace(/[\t\r\n]/g, '').replaceAll('\\', '/'));
  if (!match) return false;
  // Tolerant decoding is only for quarantine, never callback acceptance. A malformed escape
  // in userinfo must not hide the reserved host from this guard.
  const authority = (match[1] ?? '').replace(/%([0-9a-f]{2})/gi, (_escape: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return authority.split('@').some((part) => /^sso(?:[^a-z0-9_-]|$)/i.test(part));
}

function callback(raw: string): { flowId: string; ticket: string } | null {
  if (raw.length > 4096 || !raw.startsWith('calab://sso/complete?') || raw.includes('#')) return null;
  const parts = raw.slice('calab://sso/complete?'.length).split('&');
  if (parts.length !== 2) return null;
  const values = new Map<string, string>();
  for (const part of parts) {
    const match = /^(flow|ticket)=([^=]*)$/.exec(part);
    if (!match) return null;
    const key = match[1] ?? '';
    if (values.has(key)) return null;
    try {
      const value = decodeURIComponent(match[2] ?? '');
      if (!/^[\x21-\x7e]+$/.test(value) || value.length > (key === 'flow' ? 128 : 2048)) return null;
      values.set(key, value);
    } catch {
      return null;
    }
  }
  const flowId = values.get('flow');
  const ticket = values.get('ticket');
  return flowId && ticket ? { flowId, ticket } : null;
}

function trustedOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && url.origin === raw && !url.username && !url.password) return raw;
  } catch { /* Report only a fixed error, never a URL or credential. */ }
  throw new Error('Invalid SSO server origin');
}

/**
 * Usage (main only): prepare(saved context) -> pass public challenge to generated begin API
 * -> associateAndOpen(attemptId, server flow ID, browser_start_url, expires_at in epoch ms).
 * Register handleCallback with setSsoDeepLinkHandler before processing startup argv.
 * Cancel on user cancellation; invalidateForServerSwitch / invalidateForAccountSwitch before
 * changing auth context. Exchange owns token persistence and must check the supplied signal
 * after awaits and before committing; no exchange result, ticket or verifier goes over IPC.
 * This primitive neither calls a backend nor installs a login/session by itself.
 */
export class SsoHandoffBroker {
  #deps: SsoHandoffDeps;
  #pending = new Map<string, Pending>();
  #flows = new Map<string, string>();
  #seen = new Map<string, number>();

  constructor(deps: SsoHandoffDeps) { this.#deps = deps; }

  #now(): number { return this.#deps.now?.() ?? Date.now(); }

  #prune(): void {
    const now = this.#now();
    for (const [id, entry] of this.#pending) if (entry.expiresAt <= now) this.cancel(id);
    for (const [flow, deadline] of this.#seen) if (deadline <= now) this.#seen.delete(flow);
  }

  prepare(context: SsoHandoffContext): SsoChallenge {
    this.#prune();
    const saved = { ...context, serverOrigin: trustedOrigin(context.serverOrigin) };
    if (!saved.workspaceId || saved.workspaceId.length > 128 || !['login', 'step_up', 'link', 'test'].includes(saved.purpose)) {
      throw new Error('Invalid SSO context');
    }
    if (this.#pending.size >= SSO_MAX_PENDING) throw new Error('SSO pending limit reached');
    const random = this.#deps.random ?? randomBytes;
    const entropy = random(32);
    const attemptEntropy = random(32);
    if (entropy.length !== 32 || attemptEntropy.length !== 32) throw new Error('Invalid SSO entropy');
    const verifier = Buffer.from(entropy).toString('base64url');
    const attemptId = Buffer.from(attemptEntropy).toString('base64url');
    if (this.#pending.has(attemptId)) throw new Error('SSO attempt collision');
    const expiresAt = this.#now() + SSO_PENDING_TTL_MS;
    const timer = setTimeout(() => { this.cancel(attemptId); }, SSO_PENDING_TTL_MS);
    timer.unref();
    this.#pending.set(attemptId, { context: saved, verifier, expiresAt, consumed: false, controller: new AbortController(), timer });
    return { attemptId, challenge: createHash('sha256').update(verifier).digest('base64url'), method: 'S256', expiresAt };
  }

  async associateAndOpen(attemptId: string, flowId: string, browserStartUrl: string, serverExpiresAt: number): Promise<void> {
    this.#prune();
    const entry = this.#pending.get(attemptId);
    if (!entry || entry.flowId || entry.consumed) throw new Error('SSO attempt unavailable');
    try {
      if (!/^[\x21-\x7e]{1,128}$/.test(flowId) || this.#seen.has(flowId) || this.#seen.size >= MAX_SEEN_FLOWS) {
        throw new Error('Invalid SSO flow');
      }
      const url = new URL(browserStartUrl);
      // Compare the raw prefix as well: URL parsing normalizes dot segments and backslashes.
      if (browserStartUrl.length > 4096 || !browserStartUrl.startsWith(`${entry.context.serverOrigin}${BROWSER_START_PATH}?`) ||
          /[\s\\#]/.test(browserStartUrl) || url.origin !== entry.context.serverOrigin || url.pathname !== BROWSER_START_PATH ||
          url.username || url.password || !url.search || !Number.isFinite(serverExpiresAt) || serverExpiresAt <= this.#now()) {
        throw new Error('Invalid SSO browser start');
      }
      entry.expiresAt = Math.min(entry.expiresAt, serverExpiresAt);
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => { this.cancel(attemptId); }, entry.expiresAt - this.#now());
      entry.timer.unref();
      entry.flowId = flowId;
      this.#flows.set(flowId, attemptId);
      this.#seen.set(flowId, entry.expiresAt);
      await this.#deps.openExternal(browserStartUrl);
    } catch {
      this.cancel(attemptId);
      throw new Error('SSO browser start failed');
    }
  }

  async handleCallback(raw: string): Promise<'ignored' | 'completed' | 'failed' | 'invalidated'> {
    this.#prune();
    const parsed = callback(raw);
    const attemptId = parsed ? this.#flows.get(parsed.flowId) : undefined;
    const entry = attemptId ? this.#pending.get(attemptId) : undefined;
    if (!parsed || !attemptId || !entry || entry.consumed) return 'ignored';
    entry.consumed = true;
    this.#flows.delete(parsed.flowId); // Before any await: duplicate callbacks cannot race an exchange.
    const verifier = entry.verifier;
    entry.verifier = '';
    try {
      await this.#deps.exchange({ ...entry.context, ...parsed, verifier, signal: entry.controller.signal });
      return entry.controller.signal.aborted ? 'invalidated' : 'completed';
    } catch {
      return entry.controller.signal.aborted ? 'invalidated' : 'failed';
    } finally {
      this.cancel(attemptId);
    }
  }

  /** Accepts the public attempt ID, including while begin/open/exchange is in flight. */
  cancel(attemptId: string): void {
    const entry = this.#pending.get(attemptId);
    if (!entry) return;
    entry.controller.abort();
    entry.verifier = '';
    clearTimeout(entry.timer);
    if (entry.flowId) this.#flows.delete(entry.flowId);
    this.#pending.delete(attemptId);
  }

  invalidateForServerSwitch(): void { this.#invalidate(); }
  invalidateForAccountSwitch(): void { this.#invalidate(); }

  #invalidate(): void {
    for (const id of this.#pending.keys()) this.cancel(id);
  }
}
