import { net, protocol } from 'electron';
import { readBodyUpTo } from '../shared/bodyBuffer';
import { API_SCHEME } from '../shared/ipc';
import { currentServerUrl, forceRefresh, getAccessToken } from './auth';

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
async function forward(req: Request, target: string, token: string | null, body: ReadableStream | Uint8Array | null): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete('origin');
  headers.delete('referer');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, redirect: 'manual' };
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
    res = await net.fetch(url, { method: req.method, headers: h, redirect: 'manual' });
  }
  return res;
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
    try {
      // Small bodies (JSON) are buffered so a POST/PATCH/DELETE can be replayed once after a 401
      // (clock skew / expired token → spurious send failures, review L6). A 401 means the server
      // did nothing, so the replay is safe. Big bodies (uploads) stream and are never replayed.
      const read = idempotent ? null : await readBodyUpTo(req.body as ReadableStream<Uint8Array> | null);
      const body = read ? (read.kind === 'bytes' ? read.bytes : read.stream) : null;
      const replayable = !read || read.kind === 'bytes';
      let res = await forward(req, target, await getAccessToken(), body);
      if (res.status === 401 && replayable) {
        const t = await forceRefresh();
        if (t) res = await forward(req, target, t, body);
      }
      return withCors(res, origin);
    } catch (err) {
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
