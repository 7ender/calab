import { notFound } from 'next/navigation';
import { Downloads } from '@/components/downloads';
import { Faq } from '@/components/faq';
import { Features } from '@/components/features';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { Hero } from '@/components/hero';
import { Pricing } from '@/components/pricing';
import { Why } from '@/components/why';
import { getDict, isLocale, LOCALE_INFO, localePath } from '@/i18n';
import { APP_URL, DOWNLOADS, REPO_URL, SITE_URL } from '@/lib/site';

/** schema.org SoftwareApplication of the page's language (search engines; no runtime cost). */
function jsonLd(locale: Parameters<typeof getDict>[0]): string {
  const t = getDict(locale);
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Calab',
    url: `${SITE_URL}${localePath(locale)}`,
    inLanguage: LOCALE_INFO[locale].lang,
    description: t.meta.description,
    applicationCategory: 'CommunicationApplication',
    operatingSystem: 'macOS, Windows, Linux, Web',
    image: `${SITE_URL}/og/${LOCALE_INFO[locale].lang}.png`,
    screenshot: `${SITE_URL}/screens/${LOCALE_INFO[locale].lang}/voice@2x.webp`,
    downloadUrl: [DOWNLOADS.macArm64, DOWNLOADS.win, DOWNLOADS.appImage],
    installUrl: APP_URL,
    sameAs: [REPO_URL],
    license: 'https://spdx.org/licenses/BUSL-1.1.html',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@type': 'Organization', name: 'GPTunneL', url: 'https://gptunnel.ai' },
  }).replace(/</g, '\\u003c');
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDict(locale);
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(locale) }} />
      <Header t={t.header} locale={locale} />
      <main id="main">
        <Hero t={t.hero} locale={locale} />
        <Why t={t.why} />
        <Features t={t.features} locale={locale} />
        <Pricing t={t.pricing} />
        <Downloads t={t.downloads} />
        <Faq t={t.faq} />
      </main>
      <Footer t={t.footer} locale={locale} />
    </>
  );
}
