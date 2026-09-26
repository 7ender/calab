/**
 * Electron renderer `connect-src` (security review L3). The meta CSP in index.html must allow
 * any server (it is static); main adds this narrower policy as a response header on our page,
 * and browsers enforce both. Pure for tests.
 *
 * Allowed: our own origin, the API proxy scheme, blob/data (media previews), the server
 * origin over ws(s)/http(s) (gateway), and its subdomains (LiveKit lives on `rtc.<domain>`).
 * A loopback server (dev, tests) allows any loopback port (local LiveKit on :7880).
 * `extra`: space-separated sources for deployments with LiveKit on another domain
 * (CALABA_CSP_CONNECT / MAIN_VITE_CSP_CONNECT).
 */
export function connectSrc(serverUrl: string, apiScheme: string, extra = ''): string {
  const out = ["'self'", `${apiScheme}:`, 'blob:', 'data:'];
  try {
    const u = new URL(serverUrl);
    const secure = u.protocol === 'https:';
    const host = u.hostname;
    const port = u.port ? `:${u.port}` : '';
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    if (loopback) {
      for (const h of ['127.0.0.1', 'localhost']) out.push(`http://${h}:*`, `ws://${h}:*`);
    } else {
      const [http, ws] = secure ? ['https:', 'wss:'] : ['http:', 'ws:'];
      out.push(`${http}//${host}${port}`, `${ws}//${host}${port}`, `${http}//*.${host}`, `${ws}//*.${host}`);
    }
  } catch {
    // no/invalid server URL: only the local sources
  }
  for (const s of extra.split(/\s+/)) if (/^(https?|wss?):\/\/[^\s;,'"]+$/.test(s)) out.push(s);
  return out.join(' ');
}
