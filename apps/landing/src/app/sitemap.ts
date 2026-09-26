import type { MetadataRoute } from 'next';
import { hreflangAlternates, LOCALES, localePath } from '@/i18n/locales';
import { SITE_URL } from '@/lib/site';

export const dynamic = 'force-static';

// The locale pages (the root `/` is only a redirect). Each entry lists every language version (hreflang).
export default function sitemap(): MetadataRoute.Sitemap {
  const languages = Object.fromEntries(
    Object.entries(hreflangAlternates()).map(([lang, path]) => [lang, `${SITE_URL}${path}`]),
  );
  return LOCALES.map((l) => ({
    url: `${SITE_URL}${localePath(l)}`,
    changeFrequency: 'monthly',
    priority: 1,
    alternates: { languages },
  }));
}
