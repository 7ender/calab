/** Only the opaque consent handle may survive a same-session SSO navigation. */
export function consentReturnPath(value: string, origin: string): string | undefined {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname !== '/oauth/consent' || url.hash || url.searchParams.getAll('request').length !== 1) return;
    const handle = url.searchParams.get('request') ?? '';
    if (/^[A-Za-z0-9_-]{32,128}$/.test(handle)) return `/oauth/consent?request=${handle}`;
  } catch {
    /* Invalid public navigation context cannot become a redirect. */
  }
}
