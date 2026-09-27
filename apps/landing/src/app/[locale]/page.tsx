import { Downloads } from '@/components/downloads';
import { Faq } from '@/components/faq';
import { Features } from '@/components/features';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { Hero } from '@/components/hero';
import { HowItWorks } from '@/components/how';
import { Pricing } from '@/components/pricing';
import { getDict, isLocale } from '@/i18n';
import { notFound } from 'next/navigation';

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDict(locale);
  return (
    <>
      <Header t={t.header} locale={locale} />
      <main id="main">
        <Hero t={t.hero} />
        <Features t={t.features} />
        <HowItWorks t={t.how} />
        <Downloads t={t.downloads} />
        <Pricing t={t.pricing} />
        <Faq t={t.faq} />
      </main>
      <Footer t={t.footer} locale={locale} />
    </>
  );
}
