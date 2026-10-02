import { Feather, FileText, Globe, Server, type LucideIcon } from 'lucide-react';
import type { Dict } from '@/i18n';
import { rich } from '@/lib/rich';
import { Container } from './ui';

type WhyId = keyof Dict['why']['items'];

const ITEMS: { id: WhyId; icon: LucideIcon }[] = [
  { id: 'light', icon: Feather },
  { id: 'server', icon: Server },
  { id: 'network', icon: Globe },
  { id: 'recording', icon: FileText },
];

/** «Почему Calab»: four compact facts right under the hero (CPU numbers — docs/14). */
export function Why({ t }: { t: Dict['why'] }) {
  const code = <code className="rounded-md bg-code px-1.5 py-0.5 font-mono text-[13px] whitespace-nowrap text-fg">docker compose up</code>;
  return (
    <section id="why" aria-labelledby="why-title" className="border-y border-line py-12 sm:py-16">
      <Container>
        <h2 id="why-title" className="editorial-eyebrow">
          {t.title}
        </h2>
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ITEMS.map(({ id, icon: Icon }) => (
            <li key={id} className="flex gap-4 rounded-[16px] border border-line bg-card p-5 lg:flex-col lg:gap-3">
              <Icon aria-hidden="true" className="size-6 shrink-0 text-accent" strokeWidth={1.75} />
              <div>
                <h3 className="text-[17px] leading-6 font-bold">{t.items[id].title}</h3>
                <p className="mt-1 text-[15px] leading-6 text-pretty text-fg-2">{rich(t.items[id].text, { code })}</p>
              </div>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
