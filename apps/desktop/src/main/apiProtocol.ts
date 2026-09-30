import { net, protocol } from 'electron';
import { readBodyUpTo } from '../shared/bodyBuffer';
import { API_SCHEME } from '../shared/ipc';
import { currentServerUrl, forceRefresh, getAccessToken } from './auth';
import { log } from './logging';

/**
 * `calaba-api://api/<path>` → `<serverUrl>/<path>` with `Authorization: Bearer`.
 *
 * Why a proxy scheme instead of direct fetch from the renderer:
 * - the API has no CORS (desktop-only clients), and the renderer's origin is
 *   http://localhost (dev) or file:// (prod);
 * - <img src> for files/thumbnails needs the bearer header, which an <img>
 *   cannot send; here main attaches it;
 * - tokens stay under main's control (single-flight refresh).
 */
export function registerApiScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: API_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

/**
 * CORS for our renderer only (security review L2): echo the Origin when it is the packaged
 * renderer (`file://`) or the dev server; anything else gets no Access-Control-Allow-Origin,
 * so a stray frame can't read responses that carry our bearer token.
 */
function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (origin === 'file://') return origin;
  const dev = process.env['ELECTRON_RENDERER_URL'];
  if (dev && origin === new URL(dev).origin) return origin;
  return null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = allowedOrigin(origin);
  if (!allow) return {};
  return {
    'Access-Control-Allow-Origin': allow,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Disposition, Retry-After',
    'Access-Control-Max-Age': '600',
  };
}

function withCors(res: Response, origin: string | null): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const MAX_REDIRECTS = 3;

/**
 * Redirects are followed by hand: to the API origin with the token; to another origin
 * (e.g. object storage) only for GET/HEAD and WITHOUT Authorization; non-GET never.
 */
async function forward(
  req: Request,
  target: string,
  token: string | null,
  body: ReadableStream | Uint8Array | null,
  signal: AbortSignal,
): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete('origin');
  headers.delete('referer');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, redirect: 'manual', signal };
  if (body instanceof Uint8Array) {
    init.body = body;
  } else if (body) {
    init.body = body;
    init.duplex = 'half'; // streamed request body (uploads)
  }
  let res = await net.fetch(target, init);
  const idempotent = req.method === 'GET' || req.method === 'HEAD';
  let url = target;
  for (let hop = 0; hop < MAX_REDIRECTS && idempotent && res.status >= 300 && res.status < 400; hop++) {
    const loc = res.headers.get('location');
    if (!loc) break;
    const next = new URL(loc, url);
    const sameOrigin = next.origin === new URL(target).origin;
    const h = new Headers(headers);
    if (!sameOrigin) h.delete('Authorization');
    url = next.toString();
    res = await net.fetch(url, { method: req.method, headers: h, redirect: 'manual', signal });
  }
  return res;
}

/** Connect + response-headers deadline for a request whose body (if any) is small enough to be
 * buffered up front (readBodyUpTo). This is the dead/changed-connection bug (docs/12 "net.fetch
 * has no timeout"): net.fetch's promise itself never settles. Armed only until a response is in
 * hand, then permanently disarmed — it never threatens a body that is already streaming. */
export const HEADERS_TIMEOUT_MS = 20_000;

/** No bytes — request or response, either direction — for this long → abort. Reset on every
 * chunk, so an upload or a large file/image download (served through this same scheme, see the
 * doc comment above) that is still making progress is never cut off by a fixed deadline. */
export const IDLE_TIMEOUT_MS = 30_000;

/**
 * Requests the server answers only after a long wait by design: the SIP connection test (ADR-0046,
 * `POST /api/workspaces/{id}/sip/test`) places a real call and replies within ~25 s. Both
 * deadlines stretch to this for them (the fixed 20 s headers deadline would cut every slow test).
 */
export const SLOW_REQUEST_MS = 45_000;
const SLOW_PATHS = [/^\/api\/workspaces\/[^/]+\/sip\/test$/];

/** The headers / idle deadline of a request to `pathname`. */
export function deadlinesFor(pathname: string): { headers: number; idle: number } {
  return SLOW_PATHS.some((re) => re.test(pathname)) ? { headers: SLOW_REQUEST_MS, idle: SLOW_REQUEST_MS } : { headers: HEADERS_TIMEOUT_MS, idle: IDLE_TIMEOUT_MS };
}

function timeoutError(message: string): DOMException {
  return new DOMException(message, 'TimeoutError');
}

/**
 * Wraps a request or response body stream so main never awaits a chunk forever. `onChunk` fires
 * on every chunk (the caller's idle-timeout reset); if `stop` aborts while a read is outstanding
 * (idle timeout, or the renderer's own cancel via `req.signal` if Electron forwards it onto the
 * Request — see handleApiScheme), the wrapped stream ends in an error instead of silently
 * closing with a truncated body.
 */
function watchBody(source: ReadableStream<Uint8Array>, stop: AbortSignal, onChunk: () => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const onAbort = (): void => {
    void reader.cancel(stop.reason).catch(() => undefined);
  };
  stop.addEventListener('abort', onAbort, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          stop.removeEventListener('abort', onAbort);
          // A cancel triggered by our own timeout surfaces as a normal EOF from the reader's
          // point of view (per the Streams spec) — treat it as an error, not a truncated success.
          if (stop.aborted) controller.error(stop.reason);
          else controller.close();
          return;
        }
        onChunk();
        controller.enqueue(result.value);
      } catch (err) {
        stop.removeEventListener('abort', onAbort);
        controller.error(stop.aborted ? stop.reason : err);
      }
    },
    cancel(reason) {
      stop.removeEventListener('abort', onAbort);
      return reader.cancel(reason);
    },
  });
}

export function handleApiScheme(): void {
  protocol.handle(API_SCHEME, async (req) => {
    const origin = req.headers.get('origin');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    const url = new URL(req.url);
    const base = currentServerUrl();
    if (!base) return withCors(Response.json({ code: 'ERROR_CODE_UNAVAILABLE', message: 'server URL not set' }, { status: 503 }), origin);
    const target = `${base}${url.pathname}${url.search}`;
    const idempotent = req.method === 'GET' || req.method === 'HEAD';
    const deadline = deadlinesFor(url.pathname);

    const idleController = new AbortController();
    const headersController = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let headersTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idleController.abort(timeoutError('idle timeout')), deadline.idle);
    };
    const disarmHeaders = (): void => {
      clearTimeout(headersTimer);
      headersTimer = undefined;
    };
    const disarmAll = (): void => {
      clearTimeout(idleTimer);
      disarmHeaders();
    };
    // Honours the renderer's own cancellation if Electron forwards the fetch()'s AbortSignal
    // onto this Request (no extra plumbing needed on the renderer side either way — `req.signal`
    // is a plain, always-present part of the standard Request object protocol.handle hands us).
    const bodySignal = AbortSignal.any([idleController.signal, req.signal]);
    const fetchSignal = AbortSignal.any([idleController.signal, headersController.signal, req.signal]);

    try {
      armIdle();
      // Small bodies (JSON) are buffered so a POST/PATCH/DELETE can be replayed once after a 401
      // (clock skew / expired token → spurious send failures, review L6). A 401 means the server
      // did nothing, so the replay is safe. Big bodies (uploads) stream and are never replayed.
      const read = idempotent
        ? null
        : await readBodyUpTo(req.body ? watchBody(req.body as ReadableStream<Uint8Array>, bodySignal, armIdle) : null);
      const streamed = read?.kind === 'stream';
      const body = read ? (read.kind === 'bytes' ? read.bytes : read.stream) : null;
      const replayable = !read || read.kind === 'bytes';

      // Only the plain (buffered-body) path gets the fixed connect+headers deadline; a streamed
      // upload is already covered end to end by the idle timer above.
      if (!streamed) headersTimer = setTimeout(() => headersController.abort(timeoutError('connect/headers timeout')), deadline.headers);

      let res = await forward(req, target, await getAccessToken(), body, fetchSignal);
      if (res.status === 401 && replayable) {
        const t = await forceRefresh();
        if (t) res = await forward(req, target, t, body, fetchSignal);
      }
      disarmHeaders();
      armIdle(); // fresh idle window for the response body, whatever was spent on the request

      let finalRes = res;
      if (res.body) {
        // Buffer small responses (same threshold as request bodies) so a stall while we're still
        // assembling an ordinary JSON reply can still end in a clean 504. Large ones (file /
        // image / audio previews served through this same scheme) exceed the limit and stream
        // straight through from here on — only the idle timer can end them, never cut by a fixed
        // deadline, per docs/12.
        const watched = watchBody(res.body, bodySignal, armIdle);
        const readRes = await readBodyUpTo(watched);
        finalRes =
          readRes.kind === 'bytes'
            ? new Response(readRes.bytes, { status: res.status, statusText: res.statusText, headers: res.headers })
            : new Response(readRes.stream, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
      disarmAll();
      return withCors(finalRes, origin);
    } catch (err) {
      disarmAll();
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        log.warn(`api request timeout ${req.method} ${url.pathname}`);
        return withCors(Response.json({ code: 'ERROR_CODE_UNAVAILABLE', message: 'request timed out' }, { status: 504 }), origin);
      }
      return withCors(
        Response.json(
          { code: 'ERROR_CODE_UNAVAILABLE', message: err instanceof Error ? err.message : String(err) },
          { status: 503 },
        ),
        origin,
      );
    }
  });
}
