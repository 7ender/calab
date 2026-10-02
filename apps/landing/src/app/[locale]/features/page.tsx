import { notFound } from 'next/navigation';
import { Features } from '@/components/features';
import { Performance } from '@/components/performance';
import { Header } from '@/components/header';
import { Footer } from '@/components/footer';
import { getDict, isLocale } from '@/i18n';
import { getStory } from '@/i18n/story';
import { Container } from '@/components/ui';
export default async function FeaturesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDict(locale); const s = getStory(locale);
  return <><Header t={t.header} locale={locale} page="features/" /><main id="main"><Container className="py-20"><p className="story-kicker">Calab</p><h1 className="editorial-title mt-6">{s.detail}</h1></Container><Features t={t.features} locale={locale} /><Performance t={t.perf} locale={locale} /></main><Footer t={t.footer} locale={locale} /></>;
}
