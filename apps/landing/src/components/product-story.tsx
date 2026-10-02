import { ArrowUpRight } from 'lucide-react';
import type { Locale } from '@/i18n';
import { localePath } from '@/i18n/locales';
import { getStory } from '@/i18n/story';
import { Container } from './ui';
import { ControlInfographic } from './control-infographic';
import { ProductPreview } from './product-preview';

export function ProductStory({ locale }: { locale: Locale }) {
  const s = getStory(locale);
  return <div id="features">
    <section className="story-section product-section" aria-labelledby="product-title">
      <Container><h2 id="product-title" className="product-section-title">{s.previewTitle}</h2></Container>
      <ProductPreview locale={locale} label={s.scene} />
      <Container><div className="story-caption"><a className="inline-flex items-center gap-2" href={localePath(locale, 'features/')}>{s.more}<ArrowUpRight size={18} aria-hidden /></a></div></Container>
    </section>
    <section id="control" className="story-section control-section" aria-labelledby="control-title">
      <Container><ControlInfographic locale={locale} title={s.control} /></Container>
    </section>
  </div>;
}
