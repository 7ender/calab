import type { Dict, Locale } from '@/i18n';
import { localePath } from '@/i18n/locales';
import { APP_URL, REPO_URL } from '@/lib/site';
import { LocaleSwitcher } from './locale-switcher';
import { Button, Container } from './ui';

/** `page`: '' on the home page, 'bots/' on /<locale>/bots/ — section links then lead back to the home page. */
export function Header({ t, locale, page = '' }: { t: Dict['header']; locale: Locale; page?: string }) {
  const home = page === '' ? '' : localePath(locale);
  const nav = [
    { href: `${home}#features`, label: t.nav.features },
    { href: `${home}#how`, label: t.nav.how },
    { href: `${home}#download`, label: t.nav.download },
    { href: `${home}#pricing`, label: t.nav.pricing },
    { href: `${home}#faq`, label: t.nav.faq },
    { href: localePath(locale, 'bots/'), label: t.nav.bots, current: page === 'bots/' },
    { href: REPO_URL, label: 'GitHub' },
  ];
  return (
    <header className="glass sticky top-0 z-10 border-b border-line">
      <a
        href="#main"
        className="sr-only rounded-md bg-card-raised text-[14px] shadow-window focus:not-sr-only focus:absolute focus:top-2 focus:left-4 focus:z-20 focus:px-4 focus:py-2"
      >
        {t.skip}
      </a>
      <Container className="flex h-13 items-center justify-between gap-3">
        <a href={home === '' ? '#top' : home} className="flex shrink-0 items-center gap-2 rounded-md" aria-label={t.home}>
          <img src="/icon-192.png" alt="" width={28} height={28} className="size-7" />
          <span className="text-[17px] font-semibold tracking-tight">Calab</span>
        </a>
        <nav aria-label={t.navLabel} className="hidden lg:block">
          <ul className="flex items-center gap-6 text-[14px] text-fg-2">
            {nav.map((n) => (
              <li key={n.href}>
                <a
                  href={n.href}
                  aria-current={n.current ? 'page' : undefined}
                  className={
                    'rounded-md whitespace-nowrap hover:text-fg motion-safe:transition-colors' + (n.current ? ' font-medium text-fg' : '')
                  }
                >
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 items-center gap-2">
          <LocaleSwitcher locale={locale} label={t.language} page={page} />
          {/* Phones: a short label, so logo + language + button fit 360 px in every locale. */}
          <Button href={APP_URL} size="sm" variant="secondary">
            <span className="sm:hidden">{t.openWebShort}</span>
            <span className="hidden sm:inline">{t.openWeb}</span>
          </Button>
        </div>
      </Container>
    </header>
  );
}
