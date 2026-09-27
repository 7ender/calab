import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Dict } from '@/i18n';
import { APP_URL, CONTACT_EMAIL, repoFile } from '@/lib/site';
import { Button, Section, SectionHeading } from './ui';

const PLAN_IDS = ['free', 'team', 'selfHosted'] as const;
const TEAM_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Calab Team')}`;

// One entry per plan id, kept separate from the shared card markup below: each plan's CTA has a
// different shape (Free: two buttons; Team/Self-hosted: one), so this reads t.free/t.team/t.selfHosted
// directly instead of a generic `t[id]` union, which TS can't narrow from a sibling `id === …` check.
const CTA: Record<(typeof PLAN_IDS)[number], (t: Dict['pricing']) => ReactNode> = {
  free: (t) => (
    <div className="flex gap-2">
      <Button href={APP_URL} variant="secondary" size="card" className="min-w-0 flex-1">
        {t.free.ctaWeb}
      </Button>
      <Button href="#download" variant="primary" size="card" className="min-w-0 flex-1">
        {t.free.ctaDownload}
      </Button>
    </div>
  ),
  team: (t) => (
    <Button href={TEAM_MAILTO} variant="primary" className="w-full">
      {t.team.cta}
    </Button>
  ),
  selfHosted: (t) => (
    <Button href={repoFile('COMMERCIAL-LICENSE.md')} variant="secondary" className="w-full">
      {t.selfHosted.cta}
    </Button>
  ),
};

export function Pricing({ t }: { t: Dict['pricing'] }) {
  return (
    <Section id="pricing" labelledBy="pricing-title">
      <SectionHeading id="pricing-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
      <ul className="mx-auto mt-12 grid max-w-[1000px] gap-4 sm:mt-16 md:grid-cols-3 md:gap-6">
        {PLAN_IDS.map((id) => {
          const plan = t[id];
          return (
            <li key={id} className="flex flex-col rounded-[20px] border border-line bg-card p-6 sm:p-8">
              <h3 id={`plan-${id}`} className="text-[17px] leading-6 font-semibold">
                {plan.name}
              </h3>
              <p className="mt-2 text-[26px] leading-8 font-semibold tracking-tight">{plan.price}</p>
              <p className="mt-1 text-[14px] leading-5 text-fg-2">{plan.note}</p>
              <ul aria-labelledby={`plan-${id}`} className="mt-6 flex flex-col gap-3 text-[15px] leading-6">
                {plan.items.map((it) => (
                  <li key={it} className="flex gap-3">
                    <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" strokeWidth={2} />
                    <span>{it}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-8">{CTA[id](t)}</div>
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
