import { ArrowRight, AudioLines, Bot, Check, FileText, MessagesSquare, MonitorUp, PhoneCall, Smartphone, type LucideIcon } from 'lucide-react';
import type { Dict, Locale } from '@/i18n';
import { localePath } from '@/i18n/locales';
import { Section, SectionHeading, ThemedImage } from './ui';

type RowId = 'voice' | 'stream' | 'chat' | 'dm' | 'recording';

/**
 * Feature rows (landing v2, docs/09 #97): text 40 % / screenshot 60 %, alternating sides, stacked on
 * phones. Each screenshot keeps its own aspect (no empty frames); width/height are CSS pixels (half the
 * 2x file) so nothing shifts while it loads. The first two rows load eagerly. Screenshots stay Russian
 * in every locale for now (apps/landing/README.md, known limitation).
 */
const ROWS: { id: RowId; icon: LucideIcon; shot: string; width: number; height: number }[] = [
  { id: 'voice', icon: AudioLines, shot: 'voice', width: 660, height: 494 },
  { id: 'stream', icon: MonitorUp, shot: 'stream', width: 660, height: 400 },
  { id: 'chat', icon: MessagesSquare, shot: 'chat', width: 660, height: 400 },
  { id: 'dm', icon: PhoneCall, shot: 'call', width: 950, height: 600 },
  { id: 'recording', icon: FileText, shot: 'recording', width: 704, height: 344 },
];

export function Features({ t, locale }: { t: Dict['features']; locale: Locale }) {
  return (
    <Section id="features" labelledBy="features-title" alt>
      <SectionHeading id="features-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
      <ul className="mt-12 flex flex-col gap-16 sm:mt-16 sm:gap-24">
        {ROWS.map((r, i) => {
          const item = t.items[r.id];
          return (
            <li key={r.id} className="grid items-center gap-8 md:grid-cols-5 md:gap-12">
              <div className={i % 2 === 1 ? 'md:order-2 md:col-span-2' : 'md:col-span-2'}>
                <r.icon aria-hidden="true" className="size-7 text-accent" strokeWidth={1.75} />
                <h3 className="mt-4 text-[24px] leading-8 font-semibold tracking-tight text-balance">{item.title}</h3>
                <p className="mt-3 text-[17px] leading-7 text-pretty text-fg-2">{item.text}</p>
                <ul className="mt-5 flex flex-col gap-2 text-[15px] leading-6">
                  {item.points.map((p) => (
                    <li key={p} className="flex gap-3">
                      <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" strokeWidth={2} />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className={i % 2 === 1 ? 'md:order-1 md:col-span-3' : 'md:col-span-3'}>
                <div className="overflow-hidden rounded-[12px] border border-line bg-card shadow-window">
                  <ThemedImage name={r.shot} alt={item.alt} width={r.width} height={r.height} eager={i < 2} sizes="(min-width: 768px) 640px, 100vw" />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <ul className="mt-16 grid gap-4 sm:mt-24 md:grid-cols-2 md:gap-6">
        <li id="bots" className="flex min-w-0 flex-col rounded-[20px] border border-line bg-card p-6 sm:p-8">
          <Bot aria-hidden="true" className="size-7 text-accent" strokeWidth={1.75} />
          <h3 className="mt-4 text-[21px] leading-7 font-semibold tracking-tight">{t.items.bots.title}</h3>
          <p className="mt-2 text-[15px] leading-6 text-pretty text-fg-2">{t.items.bots.text}</p>
          <pre className="mt-6 overflow-x-auto rounded-lg bg-code px-4 py-3 font-mono text-[13px] leading-5">
            {/* From examples/bots/echo (the SDK's real calls, as on the /bots page). */}
            <code>
              {"bot.on('message', (m) => bot.reply(m, m.content));"}
              {'\n'}
              {'await bot.start();'}
            </code>
          </pre>
          <a href={localePath(locale, 'bots/')} className="link mt-auto inline-flex items-center gap-1 pt-6 text-[15px] leading-6 font-medium">
            {t.items.bots.link}
            <ArrowRight aria-hidden="true" className="size-4" strokeWidth={2} />
          </a>
        </li>
        <li className="flex min-w-0 flex-col overflow-hidden rounded-[20px] border border-line bg-card">
          <div className="p-6 sm:p-8">
            <Smartphone aria-hidden="true" className="size-7 text-accent" strokeWidth={1.75} />
            <h3 className="mt-4 text-[21px] leading-7 font-semibold tracking-tight">{t.items.mobile.title}</h3>
            <p className="mt-2 text-[15px] leading-6 text-pretty text-fg-2">{t.items.mobile.text}</p>
          </div>
          {/* The phone art runs off the card's bottom edge: only its top half is shown. */}
          <div className="mt-auto h-[200px] overflow-hidden sm:h-[220px]">
            <ThemedImage name="mobile" alt={t.items.mobile.alt} width={660} height={400} sizes="(min-width: 768px) 480px, 100vw" className="mx-auto max-w-[480px]" />
          </div>
        </li>
      </ul>
    </Section>
  );
}
