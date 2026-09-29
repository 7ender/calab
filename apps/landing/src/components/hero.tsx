import type { Dict, Locale } from '@/i18n';
import { APP_URL } from '@/lib/site';
import { Button, Container, ThemedImage } from './ui';

export function Hero({ t, locale }: { t: Dict['hero']; locale: Locale }) {
  return (
    <section id="top" aria-labelledby="hero-title" className="hero-bg overflow-hidden pt-10 pb-16 sm:pt-14 sm:pb-20">
      <Container className="text-center">
        <h1
          id="hero-title"
          className="mx-auto max-w-[960px] text-[36px] leading-[44px] font-bold tracking-tight text-balance sm:text-[48px] sm:leading-[56px]"
        >
          {t.title}
        </h1>
        <ul className="mx-auto mt-4 flex max-w-[960px] flex-col items-center justify-center gap-x-3 gap-y-1 sm:flex-row sm:flex-wrap text-[17px] leading-7 text-fg-2 sm:text-[19px]">
          {t.benefits.map((b, i) => (
            <li key={b} className="flex items-center gap-3">
              {i > 0 && (
                <span aria-hidden="true" className="hidden text-fg-2/60 sm:inline">
                  ·
                </span>
              )}
              {b}
            </li>
          ))}
        </ul>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="#download" className="w-full max-w-[280px] sm:w-auto">
            {t.download}
          </Button>
          <Button href={APP_URL} variant="secondary" className="w-full max-w-[280px] sm:w-auto">
            {t.openWeb}
          </Button>
        </div>
        <p className="mt-4 text-[14px] leading-5 text-fg-2">{t.trust}</p>
      </Container>
      <Container className="mt-10">
        {/* The whole window, scaled (never cropped) so it fits a 1440×900 viewport under the header and text. */}
        <div className="hero-shot mx-auto overflow-hidden rounded-[12px] border border-line bg-card shadow-window">
          <ThemedImage name="hero" locale={locale} width={1440} height={869} priority sizes="(min-width: 768px) 800px, 100vw" alt={t.shotAlt} />
        </div>
      </Container>
    </section>
  );
}
