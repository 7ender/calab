import { Check } from 'lucide-react';
import type { Dict } from '@/i18n';
import { CONTACT_EMAIL, repoFile } from '@/lib/site';
import { Button, Section, SectionHeading } from './ui';

const plans = [
  { id: 'free', href: '#download', variant: 'secondary' },
  { id: 'commercial', href: `mailto:${CONTACT_EMAIL}`, variant: 'primary' },
] as const;

export function Pricing({ t }: { t: Dict['pricing'] }) {
  return (
    <Section id="pricing" labelledBy="pricing-title">
      <SectionHeading id="pricing-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
      <ul className="mx-auto mt-12 grid max-w-[880px] gap-4 sm:mt-16 md:grid-cols-2 md:gap-6">
        {plans.map((p) => {
          const plan = t[p.id];
          return (
            <li key={p.id} className="flex flex-col rounded-[20px] border border-line bg-card p-6 sm:p-8">
              <h3 id={`plan-${p.id}`} className="text-[17px] leading-6 font-semibold">
                {plan.name}
              </h3>
              <p className="mt-2 text-[32px] leading-10 font-semibold tracking-tight">{plan.price}</p>
              <ul aria-labelledby={`plan-${p.id}`} className="mt-6 flex flex-col gap-3 text-[15px] leading-6">
                {plan.items.map((it) => (
                  <li key={it} className="flex gap-3">
                    <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" strokeWidth={2} />
                    <span>{it}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-8">
                <Button href={p.href} variant={p.variant} className="w-full">
                  {plan.cta}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mx-auto mt-8 max-w-[720px] text-center text-[14px] leading-5 text-fg-2">
        {t.license}{' '}
        <a href={repoFile('LICENSE')} className="link">
          {t.licenseLink}
        </a>
      </p>
    </Section>
  );
}
