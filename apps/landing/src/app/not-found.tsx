import type { Metadata } from 'next';
import { Container } from '@/components/ui';
import { LOCALE_INFO, LOCALES, localePath } from '@/i18n/locales';
import './globals.css';

// One 404.html for the whole export (Next exports a single not-found page), so it is locale-neutral:
// English text plus a link to every language. Caddy sends unknown locale prefixes to /en/ before this.
export const metadata: Metadata = { title: 'Page not found — Calab', robots: { index: false } };

export default function NotFound() {
  return (
    <html lang="en">
      <body className="min-h-dvh text-fg">
        <main className="flex min-h-dvh items-center">
          <Container className="text-center">
            <h1 className="text-[32px] leading-10 font-semibold tracking-tight">Page not found</h1>
            <p className="mt-3 text-[17px] leading-7 text-fg-2">The link may be out of date.</p>
            <ul className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-[17px]">
              {LOCALES.map((l) => (
                <li key={l}>
                  <a
                    href={localePath(l)}
                    hrefLang={LOCALE_INFO[l].lang}
                    lang={LOCALE_INFO[l].lang}
                    className="text-accent-text hover:underline"
                  >
                    {LOCALE_INFO[l].name}
                  </a>
                </li>
              ))}
            </ul>
          </Container>
        </main>
      </body>
    </html>
  );
}
