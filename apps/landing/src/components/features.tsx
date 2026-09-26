import { AudioLines, Globe, MessageCircle, MessagesSquare, MonitorUp, Server, ShieldCheck, Smartphone, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Dict } from '@/i18n';
import { Section, SectionHeading, ThemedImage } from './ui';

type FeatureId = keyof Dict['features']['items'];

// Screenshots stay Russian in every locale for now (apps/landing/README.md, known limitation).
const features: { id: FeatureId; icon: LucideIcon; shot?: string; extra?: (t: Dict['features']) => ReactNode }[] = [
  { id: 'voice', icon: AudioLines, shot: 'voice' },
  { id: 'stream', icon: MonitorUp, shot: 'stream' },
  { id: 'chat', icon: MessagesSquare, shot: 'chat' },
  { id: 'dm', icon: MessageCircle, shot: 'dm' },
  { id: 'mobile', icon: Smartphone, shot: 'mobile' },
  { id: 'roles', icon: ShieldCheck, shot: 'guests' },
  {
    id: 'network',
    icon: Globe,
    extra: (t) => (
      <ol aria-label={t.items.network.order} className="flex flex-wrap items-center gap-2 text-[13px] leading-5">
        {['UDP', 'TCP', 'TURN/TLS :443'].map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            {i > 0 && (
              <span aria-hidden="true" className="text-fg-2">
                →
              </span>
            )}
            <span className="rounded-md border border-line bg-card-raised px-2 py-1 font-mono">{s}</span>
          </li>
        ))}
      </ol>
    ),
  },
  {
    id: 'server',
    icon: Server,
    extra: () => (
      <pre className="overflow-x-auto rounded-lg bg-code px-4 py-3 font-mono text-[13px] leading-5">
        <code>
          <span className="text-fg-2 select-none">$ </span>docker compose up -d
        </code>
      </pre>
    ),
  },
];

const inspirations = [
  { id: 'discord', name: 'Discord' },
  { id: 'telegram', name: 'Telegram' },
  { id: 'zoom', name: 'Zoom' },
] as const;

export function Features({ t }: { t: Dict['features'] }) {
  return (
    <Section id="features" labelledBy="features-title" alt>
      <SectionHeading id="features-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
      <ul className="mt-12 grid gap-4 sm:mt-16 md:grid-cols-2 md:gap-6">
        {features.map((f) => {
          const item: { title: string; text: string; alt?: string } = t.items[f.id];
          return (
            <li key={f.id} className="flex flex-col overflow-hidden rounded-[20px] border border-line bg-card">
              <div className="flex flex-1 flex-col p-6 sm:p-8">
                <f.icon aria-hidden="true" className="size-7 text-accent" strokeWidth={1.75} />
                <h3 className="mt-4 text-[21px] leading-7 font-semibold tracking-tight">{item.title}</h3>
                <p className="mt-2 text-[15px] leading-6 text-pretty text-fg-2">{item.text}</p>
                {f.extra && <div className="mt-auto pt-6">{f.extra(t)}</div>}
              </div>
              {f.shot && (
                <div className="px-6 sm:px-8">
                  <div className="overflow-hidden rounded-t-[10px] border border-b-0 border-line">
                    <ThemedImage name={f.shot} alt={item.alt ?? ''} width={660} height={400} />
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-16 sm:mt-20">
        <h3 className="text-center text-[21px] leading-7 font-semibold tracking-tight">{t.inspiredTitle}</h3>
        <dl className="mx-auto mt-6 grid max-w-[960px] gap-6 text-center md:grid-cols-3 md:gap-8">
          {inspirations.map((i) => (
            <div key={i.id}>
              <dt className="text-[17px] leading-6 font-semibold">{i.name}</dt>
              <dd className="mt-1 text-[15px] leading-6 text-pretty text-fg-2">{t.inspired[i.id]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}
