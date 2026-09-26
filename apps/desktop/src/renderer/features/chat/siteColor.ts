/**
 * Link preview accent (docs/09 #51): a deterministic per-site colour for the card's left bar.
 *
 * TODO(contract): prefer the page's `<meta name="theme-color">` once `UnfurlResponse` carries a
 * `theme_color` field (proto/unfurl.proto → gen); fall back to this palette when it is empty.
 */

/**
 * The identity palette (styles.css `--name-*`, tuned per theme for bubbles), without the
 * neutral grey `--name-8`: a grey bar would read as «disabled».
 */
export const SITE_COLORS = ['var(--name-1)', 'var(--name-2)', 'var(--name-3)', 'var(--name-4)', 'var(--name-5)', 'var(--name-6)', 'var(--name-7)'] as const;

/** Host without `www.`, lower-cased; the input itself when it is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return url;
  }
}

/** What identifies a site: its host (pages of one site share a colour), else the OG site name. */
export function siteKey(url: string, siteName = ''): string {
  const host = hostOf(url);
  return host && host !== url ? host : siteName.trim().toLowerCase() || url;
}

/** Stable colour for a site key (same string hash as the author name colours). */
export function siteColor(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return SITE_COLORS[Math.abs(h) % SITE_COLORS.length] ?? SITE_COLORS[0];
}
