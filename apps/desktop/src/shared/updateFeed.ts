/** Update feed rules (security review M3), pure for tests. */

/** https feed URL, or null when updates are off (not packaged, no server, not https). */
export function feedUrl(serverUrl: string, override: string): string | null {
  const raw = (override || (serverUrl ? `${serverUrl.replace(/\/+$/, '')}/download/` : '')).trim();
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
