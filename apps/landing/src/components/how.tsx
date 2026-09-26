import type { Dict } from '@/i18n';
import { fmt } from '@/lib/rich';
import { Section, SectionHeading } from './ui';

const STEPS = ['server', 'install', 'invite'] as const;

export function HowItWorks({ t }: { t: Dict['how'] }) {
  return (
    <Section id="how" labelledBy="how-title">
      <SectionHeading id="how-title" eyebrow={t.eyebrow} title={t.title} />
      <ol className="mt-12 grid gap-4 sm:mt-16 md:grid-cols-3 md:gap-6">
        {STEPS.map((id, i) => (
          <li key={id} className="rounded-[20px] border border-line bg-card p-6 sm:p-8">
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-full bg-accent-tint text-[15px] font-semibold text-accent-text"
            >
              {i + 1}
            </span>
            <h3 className="mt-4 text-[21px] leading-7 font-semibold tracking-tight">
              <span className="sr-only">{fmt(t.step, { n: i + 1 })} </span>
              {t.steps[id].title}
            </h3>
            <p className="mt-2 text-[15px] leading-6 text-pretty text-fg-2">{t.steps[id].text}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
