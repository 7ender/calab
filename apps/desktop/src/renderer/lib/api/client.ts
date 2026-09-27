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
    /** Seconds from a 429's `Retry-After` header (ADR-0023: code resend, mail limits). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  is(code: string): boolean {
    return this.code === code;
  }
}

/** `Retry-After` in seconds (delta form only, as the server sends it); undefined when absent. */
export function retryAfterSeconds(res: Response): number | undefined {
  const v = Number(res.headers.get('Retry-After') ?? '');
  return Number.isFinite(v) && v > 0 ? Math.ceil(v) : undefined;
}

export async function toApiError(res: Response): Promise<ApiError> {
  const retry = retryAfterSeconds(res);
  try {
    const b = (await res.json()) as { code?: string; message?: string; field?: string };
    const err = new ApiError(b.code ?? 'ERROR_CODE_UNSPECIFIED', b.message ?? res.statusText, res.status, b.field || undefined, retry);
    for (const h of errorHooks) h(err);
    return err;
  } catch {
    return new ApiError('ERROR_CODE_UNSPECIFIED', res.statusText || `HTTP ${res.status}`, res.status, undefined, retry);
  }
}

const errorHooks = new Set<(e: ApiError) => void>();

/**
 * Observes every API error (e.g. 403 EMAIL_NOT_VERIFIED → the «Подтвердите почту» bar asks for
 * attention, ADR-0023) without each caller handling it. Returns the unsubscribe function.
 */
export function onApiError(h: (e: ApiError) => void): () => void {
  errorHooks.add(h);
  return () => errorHooks.delete(h);
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
