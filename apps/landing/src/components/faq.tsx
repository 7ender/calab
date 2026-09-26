import { ChevronDown } from 'lucide-react';
import type { Dict } from '@/i18n';
import { rich } from '@/lib/rich';
import { CONTACT_EMAIL } from '@/lib/site';
import { Section, SectionHeading } from './ui';

const ORDER = ['server', 'traffic', 'updates', 'security', 'firewall', 'limits', 'license'] as const;

export function Faq({ t }: { t: Dict['faq'] }) {
  const email = (
    <a href={`mailto:${CONTACT_EMAIL}`} className="link">
      {CONTACT_EMAIL}
    </a>
  );
  return (
    <Section id="faq" labelledBy="faq-title" alt>
      <SectionHeading id="faq-title" eyebrow={t.eyebrow} title={t.title} />
      <div className="mx-auto mt-12 max-w-[760px] divide-y divide-line border-y border-line sm:mt-16">
        {ORDER.map((id) => (
          <details key={id} className="group">
            <summary className="flex min-h-14 cursor-pointer items-center justify-between gap-4 rounded-md py-4 text-[17px] leading-6 font-semibold">
              <h3>{t.items[id].q}</h3>
              <ChevronDown
                aria-hidden="true"
                className="chevron size-5 shrink-0 text-fg-2 motion-safe:transition-transform motion-safe:duration-150"
                strokeWidth={1.75}
              />
            </summary>
            <p className="pb-5 text-[15px] leading-6 text-pretty text-fg-2">{rich(t.items[id].a, { email })}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}
