/**
 * Update feed rules (security review M3), pure for tests.
 *
 * The feed is derived from the server the app is connected to:
 * - `https://app.X[:port]` → `https://releases.X[:port]/` (the releases.<domain> vhost, see
 *   infra/docker Caddyfile); `app.calab.ru` → `https://releases.calab.ru/`;
 * - any other host → `https://<host>/download/` (the server serves the feed itself).
 * A build/launch-time override (CALABA_UPDATE_URL / MAIN_VITE_UPDATE_URL) wins. https only.
 */

/** Server URL → default feed URL (not yet validated), '' when there is no server. */
function derivedFeed(serverUrl: string): string {
  const s = serverUrl.trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    // `app.X` with a non-empty X (a bare «app» host keeps /download/).
    if (u.hostname.startsWith('app.') && u.hostname.length > 'app.'.length) {
      return `${u.protocol}//releases.${u.hostname.slice('app.'.length)}${u.port ? `:${u.port}` : ''}/`;
    }
    return `${u.origin}/download/`;
  } catch {
    return '';
  }
}

/** https feed URL (always with a trailing slash), or null when updates are off (no server, not https). */
export function feedUrl(serverUrl: string, override: string): string | null {
  const raw = (override.trim() || derivedFeed(serverUrl)).trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u.toString();
  } catch {
    return null;
  }
}
