import {
  create,
  fromJson,
  toJson,
  type DescMessage,
  type JsonValue,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';
import { platform } from '../../platform';

/**
 * Typed REST client. Bodies are protojson (lowerCamelCase, enum names,
 * uint64 as strings — docs/05, "REST"); conversion goes through the generated
 * schemas only, never hand-written types (CLAUDE.md).
 *
 * Requests go to `calaba-api://api/...`; the main process attaches the bearer
 * token, refreshes it and forwards to the configured server.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly field?: string,
    /**
     * Why, when a code has several causes (ApiError.reason): "PLAN_LIMIT" = a limit of the
     * workspace plan (ADR-0024; ROOM_FULL, FILE_QUOTA_EXCEEDED). `used` / `limit`: the counter
     * that was hit (ROOM_FULL — users; FILE_QUOTA_EXCEEDED — bytes).
     */
    readonly extra: { reason?: string; used?: number; limit?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get reason(): string | undefined {
    return this.extra.reason;
  }

  is(code: string): boolean {
    return this.code === code;
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  try {
    const b = (await res.json()) as { code?: string; message?: string; field?: string; reason?: string; used?: unknown; limit?: unknown };
    // protojson: uint64 as a string.
    const num = (v: unknown): number | undefined => (typeof v === 'string' || typeof v === 'number') && Number.isFinite(Number(v)) ? Number(v) : undefined;
    const used = num(b.used);
    const limit = num(b.limit);
    const extra = { ...(b.reason ? { reason: b.reason } : {}), ...(used !== undefined ? { used } : {}), ...(limit !== undefined ? { limit } : {}) };
    return new ApiError(b.code ?? 'ERROR_CODE_UNSPECIFIED', b.message ?? res.statusText, res.status, b.field || undefined, extra);
  } catch {
    return new ApiError('ERROR_CODE_UNSPECIFIED', res.statusText || `HTTP ${res.status}`, res.status);
  }
}

/** Absolute URL of an API path for the current platform (Electron: calaba-api://, web: same origin). */
export const apiUrl = (path: string): string => `${platform.apiBase}${path}`;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const JSON_OPTS = { ignoreUnknownFields: true } as const;

async function send(method: Method, path: string, body?: JsonValue, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await platform.apiFetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('ERROR_CODE_UNAVAILABLE', err instanceof Error ? err.message : String(err), 0);
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}

/** Request with a typed protobuf response. */
export async function call<Res extends DescMessage>(
  method: Method,
  path: string,
  resSchema: Res,
  body?: JsonValue,
  signal?: AbortSignal,
): Promise<MessageShape<Res>> {
  const res = await send(method, path, body, signal);
  const json = (await res.json()) as JsonValue;
  return fromJson(resSchema, json, JSON_OPTS);
}

/** Request without a response body (204). */
export async function callEmpty(method: Method, path: string, body?: JsonValue): Promise<void> {
  await send(method, path, body);
}

/** Serialises a request message (unset optional fields are omitted → "leave unchanged"). */
export function body<Req extends DescMessage>(schema: Req, init: MessageInitShape<Req>): JsonValue {
  return toJson(schema, create(schema, init));
}

export function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
