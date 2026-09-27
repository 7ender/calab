/**
 * A non-2xx REST response (docs/05 «REST»: the body is `ApiError` in protojson).
 *
 * `code` is the `ErrorCode` without its `ERROR_CODE_` prefix (`FORBIDDEN`, `RATE_LIMITED`,
 * `BOT_BLOCKED`, …); `reason` refines it (`BOT_NOT_ALLOWED`, `PLAN_LIMIT`, `REACTION_LIMIT`, …).
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly reason: string | undefined;
  readonly field: string | undefined;
  readonly used: bigint | undefined;
  readonly limit: bigint | undefined;
  /** From the `Retry-After` header of a 429, in milliseconds. */
  readonly retryAfterMs: number | undefined;
  readonly method: string;
  readonly path: string;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    method: string;
    path: string;
    reason?: string | undefined;
    field?: string | undefined;
    used?: bigint | undefined;
    limit?: bigint | undefined;
    retryAfterMs?: number | undefined;
  }) {
    super(`${init.method} ${init.path}: ${init.status} ${init.code}${init.reason ? ` (${init.reason})` : ''}: ${init.message}`);
    this.status = init.status;
    this.code = init.code;
    this.reason = init.reason;
    this.field = init.field;
    this.used = init.used;
    this.limit = init.limit;
    this.retryAfterMs = init.retryAfterMs;
    this.method = init.method;
    this.path = init.path;
  }
}

/** The gateway gave up for good: the token is invalid or revoked, or another process took over the session. */
export class GatewayFatalError extends Error {
  override readonly name = 'GatewayFatalError';
  constructor(
    readonly kind: GatewayFatal,
    readonly closeCode: number,
    readonly closeReason: string,
  ) {
    super(`gateway: ${kind} (close ${closeCode}${closeReason ? `: ${closeReason}` : ''})`);
  }
}

/**
 * - `auth-failed` — close 4004: the token is malformed, unknown or was re-issued;
 * - `revoked` — close 4010: the token was revoked or the bot deleted;
 * - `replaced` — close 4000 «replaced by a new session»: another process connected with the same token
 *   (a bot token is one gateway device; run one process per token);
 * - `too-many-sessions` — close 4008 before READY.
 */
export type GatewayFatal = 'auth-failed' | 'revoked' | 'replaced' | 'too-many-sessions';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const big = (v: unknown): bigint | undefined => {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  try {
    return BigInt(v);
  } catch {
    return undefined;
  }
};

/** Builds an ApiError from a response body (protojson `ApiError`, or anything else). */
export function apiErrorFrom(status: number, body: unknown, method: string, path: string, retryAfterMs?: number): ApiError {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const rawCode = str(b.code);
  return new ApiError({
    status,
    code: rawCode ? rawCode.replace(/^ERROR_CODE_/, '') : `HTTP_${status}`,
    message: str(b.message) ?? (typeof body === 'string' ? body.slice(0, 200) : 'request failed'),
    reason: str(b.reason),
    field: str(b.field),
    used: big(b.used),
    limit: big(b.limit),
    retryAfterMs,
    method,
    path,
  });
}
