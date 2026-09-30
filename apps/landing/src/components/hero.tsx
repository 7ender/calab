import { ArrowRight } from 'lucide-react';
import type { Dict, Locale } from '@/i18n';
import { APP_URL } from '@/lib/site';
import { Button, Container, Frame, Screen } from './ui';

/**
 * Landing v3 hero: a «what is new» pill, a one-line promise, the lead, two actions, then the product
 * itself — the whole window during a planning meeting (stream on the stage, cameras, rooms), in the
 * page's language. The screenshot is the LCP element: 1x ≈ 80 KB, fetched with high priority.
 */
export function Hero({ t, locale }: { t: Dict['hero']; locale: Locale }) {
  return (
    <section id="top" aria-labelledby="hero-title" className="hero-bg overflow-hidden pt-12 pb-16 sm:pt-20 sm:pb-24">
      <Container className="text-center">
        <a
          href="#sip"
          className="inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-card px-4 py-1.5 text-[14px] leading-5 font-medium text-fg hover:border-accent motion-safe:transition-colors"
        >
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent" />
          <span className="truncate">{t.badge}</span>
          <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-fg-2" strokeWidth={2} />
        </a>
        <h1
          id="hero-title"
          className="mx-auto mt-6 max-w-[900px] text-[40px] leading-[48px] font-bold tracking-tight text-balance sm:text-[64px] sm:leading-[72px]"
        >
          {t.title}
        </h1>
        <p className="mx-auto mt-5 max-w-[680px] text-[18px] leading-7 text-pretty text-fg-2 sm:text-[21px] sm:leading-8">{t.lead}</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="#download" size="lg" className="w-full max-w-[280px] sm:w-auto">
            {t.download}
          </Button>
          <Button href={APP_URL} variant="secondary" size="lg" className="w-full max-w-[280px] sm:w-auto">
            {t.openWeb}
          </Button>
        </div>
        <p className="mt-4 text-[14px] leading-5 text-fg-2">{t.trust}</p>
      </Container>
      <Container className="mt-12 sm:mt-16">
        <Frame className="hero-shot mx-auto">
          <Screen name="voice" locale={locale} priority sizes="(min-width: 1232px) 1152px, calc(100vw - 32px)" alt={t.shotAlt} />
        </Frame>
      </Container>
    </section>
  );
}
