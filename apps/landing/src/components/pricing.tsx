import { Check } from 'lucide-react';
import { CONTACT_EMAIL, repoFile } from '@/lib/site';
import { Button, Section, SectionHeading } from './ui';

const plans = [
  {
    id: 'free',
    name: 'Некоммерческое использование',
    price: 'Бесплатно',
    items: [
      'Личные проекты',
      'Некоммерческие организации, образование и исследования',
      'Оценка в любой компании — до 30 дней',
      'Условие: «Powered by GPTunneL» в интерфейсе',
    ],
    cta: { label: 'Скачать', href: '#download', variant: 'secondary' as const },
  },
  {
    id: 'commercial',
    name: 'Коммерческая лицензия',
    price: 'По запросу',
    items: [
      'Использование в бизнесе и для клиентов',
      'Self-hosted на ваших серверах или managed-размещение',
      'Условия под размер команды',
    ],
    cta: { label: 'Написать', href: `mailto:${CONTACT_EMAIL}`, variant: 'primary' as const },
  },
];

export function Pricing() {
  return (
    <Section id="pricing" labelledBy="pricing-title">
      <SectionHeading
        id="pricing-title"
        eyebrow="Лицензия"
        title="Бесплатно, если не для бизнеса"
        lead="Исходный код открыт. Для коммерческого использования нужна лицензия GPTunneL."
      />
      <ul className="mx-auto mt-12 grid max-w-[880px] gap-4 sm:mt-16 md:grid-cols-2 md:gap-6">
        {plans.map((p) => (
          <li key={p.id} className="flex flex-col rounded-[20px] border border-line bg-card p-6 sm:p-8">
            <h3 id={`plan-${p.id}`} className="text-[17px] leading-6 font-semibold">
              {p.name}
            </h3>
            <p className="mt-2 text-[32px] leading-10 font-semibold tracking-tight">{p.price}</p>
            <ul aria-labelledby={`plan-${p.id}`} className="mt-6 flex flex-col gap-3 text-[15px] leading-6">
              {p.items.map((it) => (
                <li key={it} className="flex gap-3">
                  <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" strokeWidth={2} />
                  <span>{it}</span>
                </li>
              ))}
            </ul>
            <div className="mt-auto pt-8">
              <Button href={p.cta.href} variant={p.cta.variant} className="w-full">
                {p.cta.label}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <p className="mx-auto mt-8 max-w-[720px] text-center text-[14px] leading-5 text-fg-2">
        Calab распространяется по Business Source License 1.1. Каждая версия переходит под Apache License 2.0 через четыре
        года после выпуска.{' '}
        <a href={repoFile('LICENSE')} className="link">
          Текст лицензии
        </a>
      </p>
    </Section>
  );
}
