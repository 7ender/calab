import { net, protocol } from 'electron';
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

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Disposition',
  'Access-Control-Max-Age': '600',
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function forward(req: Request, target: string, token: string | null, body: ReadableStream | null): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete('origin');
  headers.delete('referer');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, redirect: 'follow' };
  if (body) {
    init.body = body;
    init.duplex = 'half'; // streamed request body (uploads)
  }
  return net.fetch(target, init);
}

export function handleApiScheme(): void {
  protocol.handle(API_SCHEME, async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    const url = new URL(req.url);
    const base = currentServerUrl();
    if (!base) return withCors(Response.json({ code: 'ERROR_CODE_UNAVAILABLE', message: 'server URL not set' }, { status: 503 }));
    const target = `${base}${url.pathname}${url.search}`;
    const idempotent = req.method === 'GET' || req.method === 'HEAD';
    // Bodies of non-idempotent requests are streamed (uploads) and cannot be replayed.
    const body = idempotent ? null : req.body;
    try {
      let res = await forward(req, target, await getAccessToken(), body);
      if (res.status === 401 && idempotent) {
        const t = await forceRefresh();
        if (t) res = await forward(req, target, t, null);
      }
      return withCors(res);
    } catch (err) {
      return withCors(
        Response.json(
          { code: 'ERROR_CODE_UNAVAILABLE', message: err instanceof Error ? err.message : String(err) },
          { status: 503 },
        ),
      );
    }
  });
}
