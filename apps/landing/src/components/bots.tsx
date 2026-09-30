import { AudioLines, CalendarClock, CircleDot, ListChecks, MessagesSquare, SquareSlash, UsersRound, Webhook, type LucideIcon } from 'lucide-react';
import type { Dict } from '@/i18n';
import { rich } from '@/lib/rich';
import { BOT_EXAMPLES_URL, BOT_SDK_URL } from '@/lib/site';
import { BotCode } from './bot-code';
import { Button, Container, Section, SectionHeading } from './ui';

type CardId = keyof Dict['bots']['cards'];

const cards: { id: CardId; icon: LucideIcon }[] = [
  { id: 'chat', icon: MessagesSquare },
  { id: 'tasks', icon: ListChecks },
  { id: 'voice', icon: AudioLines },
  { id: 'calendar', icon: CalendarClock },
  { id: 'people', icon: UsersRound },
  { id: 'recording', icon: CircleDot },
  { id: 'commands', icon: SquareSlash },
  { id: 'webhook', icon: Webhook },
];

/** The /<locale>/bots/ page (ADR-0031 §8): what bots can do, a code sample, links to the docs on GitHub. */
export function BotsPage({ t, docsUrl }: { t: Dict['bots']; docsUrl: string }) {
  const docsLabel = t.docsLang ? `${t.docs} ${t.docsLang}` : t.docs;
  return (
    <>
      <section id="top" aria-labelledby="bots-title" className="hero-bg pt-16 pb-12 sm:pt-24 sm:pb-16">
        <Container className="text-center">
          <p className="text-[15px] leading-5 font-semibold text-accent-text">{t.eyebrow}</p>
          <h1
            id="bots-title"
            className="mx-auto mt-2 max-w-[760px] text-[36px] leading-[44px] font-bold tracking-tight text-balance sm:text-[56px] sm:leading-[64px]"
          >
            {t.title}
          </h1>
          <p className="mx-auto mt-4 max-w-[640px] text-[19px] leading-7 text-pretty text-fg-2 sm:text-[21px] sm:leading-8">{t.lead}</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button href={docsUrl} className="w-full max-w-[320px] sm:w-auto">
              {docsLabel}
            </Button>
            <Button href={BOT_SDK_URL} variant="secondary" className="w-full max-w-[320px] sm:w-auto">
              {t.sdk}
            </Button>
          </div>
          <p className="mx-auto mt-4 max-w-[560px] text-[14px] leading-5 text-pretty text-fg-2">{t.rights}</p>
        </Container>
      </section>

      <Section id="bots-features" labelledBy="bots-features-title" alt>
        <h2 id="bots-features-title" className="sr-only">
          {t.eyebrow}
        </h2>
        <ul className="grid gap-4 md:grid-cols-2 md:gap-6">
          {cards.map((c) => (
            <li key={c.id} className="rounded-[20px] border border-line bg-card p-6 sm:p-8">
              <c.icon aria-hidden="true" className="size-7 text-accent" strokeWidth={1.75} />
              <h3 className="mt-4 text-[21px] leading-7 font-semibold tracking-tight">{t.cards[c.id].title}</h3>
              <p className="mt-2 text-[15px] leading-6 text-pretty text-fg-2">{t.cards[c.id].text}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="bots-code" labelledBy="bots-code-title">
        <SectionHeading id="bots-code-title" eyebrow="@calaba/bot-sdk" title={t.codeTitle} />
        <figure className="mx-auto mt-10 max-w-[820px] sm:mt-12">
          <pre className="overflow-x-auto rounded-[16px] border border-line bg-code px-5 py-4 font-mono text-[13px] leading-6 sm:text-[14px]" lang="en">
            <BotCode />
          </pre>
          <figcaption className="mt-4 text-center text-[15px] leading-6 text-pretty text-fg-2">
            {rich(t.codeCaption, {
              examples: (
                <a href={BOT_EXAMPLES_URL} className="link font-mono text-[14px]">
                  examples/bots
                </a>
              ),
            })}
          </figcaption>
        </figure>
      </Section>

      <Section id="bots-start" labelledBy="bots-start-title" alt>
        <SectionHeading id="bots-start-title" eyebrow={t.eyebrow} title={t.ctaTitle} lead={t.ctaText} />
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href={docsUrl} className="w-full max-w-[320px] sm:w-auto">
            {docsLabel}
          </Button>
          <Button href={BOT_EXAMPLES_URL} variant="secondary" className="w-full max-w-[320px] sm:w-auto">
            examples/bots
          </Button>
        </div>
      </Section>
    </>
  );
}
