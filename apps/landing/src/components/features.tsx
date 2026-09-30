import {
  ArrowRight,
  AudioLines,
  Bot,
  CalendarCheck,
  CalendarClock,
  CalendarSync,
  Check,
  DoorOpen,
  KeyRound,
  LayoutGrid,
  Lock,
  MessagesSquare,
  NotebookPen,
  Server,
  ShieldCheck,
  Globe,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { Dict, Locale } from '@/i18n';
import { localePath } from '@/i18n/locales';
import { fmt } from '@/lib/rich';
import type { ScreenName } from '@/lib/screens';
import { Container, Frame, Screen, cx } from './ui';

type T = Dict['features'];

/** Section title block: an icon chip + eyebrow, a large title, the text. */
function Intro({ id, icon: Icon, eyebrow, title, text, center }: { id: string; icon: LucideIcon; eyebrow: string; title: string; text: string; center?: boolean }) {
  return (
    <div className={center ? 'mx-auto max-w-[760px] text-center' : undefined}>
      <p className={cx('flex items-center gap-2 text-[15px] leading-5 font-semibold text-accent-text', center && 'justify-center')}>
        <span className="inline-flex size-7 items-center justify-center rounded-lg bg-accent-tint">
          <Icon aria-hidden="true" className="size-4" strokeWidth={2} />
        </span>
        {eyebrow}
      </p>
      <h2 id={id} className="mt-4 text-[30px] leading-[38px] font-semibold tracking-tight text-balance sm:text-[44px] sm:leading-[52px]">
        {title}
      </h2>
      <p className="mt-4 text-[17px] leading-7 text-pretty text-fg-2 sm:text-[19px] sm:leading-8">{text}</p>
    </div>
  );
}

function Points({ items, className }: { items: string[]; className?: string }) {
  return (
    <ul className={cx('flex flex-col gap-3 text-[16px] leading-6', className)}>
      {items.map((p) => (
        <li key={p} className="flex gap-3">
          <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" strokeWidth={2.25} />
          <span className="text-pretty">{p}</span>
        </li>
      ))}
    </ul>
  );
}

/** Text beside a screenshot (40 / 60), stacked on phones; `flip` puts the picture first on wide screens. */
function Split({ id, flip, alt, text, shot }: { id: string; flip?: boolean; alt?: boolean; text: ReactNode; shot: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cx('py-20 sm:py-28', alt && 'surface-alt bg-bg-alt')}>
      <Container className="grid items-center gap-10 lg:grid-cols-12 lg:gap-14">
        <div className={cx('min-w-0 lg:col-span-5', flip && 'lg:order-2')}>{text}</div>
        <div className={cx('min-w-0 lg:col-span-7', flip && 'lg:order-1')}>{shot}</div>
      </Container>
    </section>
  );
}

const shot = (name: ScreenName, locale: Locale, alt: string, sizes = '(min-width: 1232px) 660px, (min-width: 1024px) 55vw, calc(100vw - 32px)') => (
  <Frame>
    <Screen name={name} locale={locale} alt={alt} sizes={sizes} />
  </Frame>
);

function Card({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <li className="rounded-[18px] border border-line bg-card p-6">
      <Icon aria-hidden="true" className="size-6 text-accent" strokeWidth={1.75} />
      <h3 className="mt-3 text-[17px] leading-6 font-semibold">{title}</h3>
      <p className="mt-1.5 text-[15px] leading-6 text-pretty text-fg-2">{text}</p>
    </li>
  );
}

/**
 * Landing v3 feature sections (docs/09 #139), in the order of the brief: voice and video, chat,
 * calendar, boards, notes, guests, bots, self-hosted. Every screenshot is the app in the page's
 * language with that language's team; nothing here needs JS.
 */
export function Features({ t, locale }: { t: T; locale: Locale }) {
  return (
    <div id="features">
      <Split
        id="voice"
        text={
          <>
            <Intro id="voice-title" icon={AudioLines} {...t.voice} />
            <Points items={t.voice.points} className="mt-7" />
          </>
        }
        shot={shot('call', locale, t.voice.alt)}
      />

      <Split
        id="chat"
        alt
        flip
        text={
          <>
            <Intro id="chat-title" icon={MessagesSquare} {...t.chat} />
            <Points items={t.chat.points} className="mt-7" />
          </>
        }
        shot={shot('chat', locale, t.chat.alt)}
      />

      <section id="calendar" aria-labelledby="calendar-title" className="py-20 sm:py-28">
        <Container>
          <Intro id="calendar-title" icon={CalendarCheck} center {...t.calendar} />
          <ul className="mt-10 grid gap-4 md:grid-cols-3">
            <Card icon={CalendarCheck} {...t.calendar.cards.invites} />
            <Card icon={CalendarClock} {...t.calendar.cards.find} />
            <Card icon={CalendarSync} {...t.calendar.cards.caldav} />
          </ul>
          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {shot('calendar', locale, t.calendar.alt, '(min-width: 1232px) 564px, (min-width: 768px) 48vw, calc(100vw - 32px)')}
            {shot('findtime', locale, t.calendar.findAlt, '(min-width: 1232px) 564px, (min-width: 768px) 48vw, calc(100vw - 32px)')}
          </div>
        </Container>
      </section>

      <section id="boards" aria-labelledby="boards-title" className="surface-alt bg-bg-alt py-20 sm:py-28">
        <Container>
          <div className="grid gap-8 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-7">
              <Intro id="boards-title" icon={LayoutGrid} {...t.boards} />
            </div>
            <div className="lg:col-span-5">
              <Points items={t.boards.points} />
              <p className="mt-4 text-[14px] leading-5 text-fg-2">{t.boards.free}</p>
            </div>
          </div>
          <div className="mt-12">{shot('kanban', locale, t.boards.alt, '(min-width: 1232px) 1152px, calc(100vw - 32px)')}</div>
          {/* Timeline and the task panel side by side: widths in the ratio of the shots (1110 : 510), so both are as tall. */}
          <div className="mt-6 grid gap-6 md:grid-cols-[1110fr_510fr]">
            {shot('timeline', locale, t.boards.timelineAlt, '(min-width: 1232px) 780px, (min-width: 768px) 66vw, calc(100vw - 32px)')}
            {shot('task', locale, t.boards.taskAlt, '(min-width: 1232px) 360px, (min-width: 768px) 30vw, calc(100vw - 32px)')}
          </div>
        </Container>
      </section>

      <Split
        id="notes"
        text={
          <>
            <Intro id="notes-title" icon={NotebookPen} {...t.notes} />
            <Points items={t.notes.points} className="mt-7" />
          </>
        }
        shot={shot('notes', locale, t.notes.alt)}
      />

      <Split
        id="guests"
        alt
        flip
        text={
          <>
            <Intro id="guests-title" icon={DoorOpen} {...t.guests} />
            <Points items={t.guests.points} className="mt-7" />
          </>
        }
        shot={
          // The waiting card on a stage of the app's background (the guest's whole window is mostly empty).
          <div className="guest-stage flex items-center justify-center rounded-[20px] px-4 py-10 sm:py-14">
            <div className="w-full max-w-[420px]">
              <Screen name="guest" locale={locale} alt={t.guests.alt} sizes="420px" />
            </div>
          </div>
        }
      />

      <Split
        id="bots"
        text={
          <>
            <Intro id="bots-title" icon={Bot} {...t.bots} />
            <Points items={t.bots.points} className="mt-7" />
            <a href={localePath(locale, 'bots/')} className="link mt-7 inline-flex items-center gap-1 text-[16px] leading-6 font-medium">
              {t.bots.link}
              <ArrowRight aria-hidden="true" className="size-4" strokeWidth={2} />
            </a>
          </>
        }
        shot={
          <Frame className="bg-[#16171b]">
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <span aria-hidden="true" className="size-3 rounded-full bg-[#ff5f57]" />
              <span aria-hidden="true" className="size-3 rounded-full bg-[#febc2e]" />
              <span aria-hidden="true" className="size-3 rounded-full bg-[#28c840]" />
              <span className="ml-2 font-mono text-[13px] text-[#a1a1a8]">echo.ts</span>
            </div>
            {/* From examples/bots/echo (the SDK's real calls, as on the /bots page). Code stays English. */}
            <pre className="overflow-x-auto px-5 py-5 font-mono text-[13px] leading-6 text-[#e8e8ed] sm:text-[14px]">
              <code>
                <span className="text-[#ff7ab2]">import</span> {'{ Bot } '}
                <span className="text-[#ff7ab2]">from</span> <span className="text-[#fc6a5d]">{"'@calaba/bot-sdk'"}</span>;{'\n\n'}
                <span className="text-[#ff7ab2]">const</span> bot = <span className="text-[#ff7ab2]">new</span> Bot(process.env.BOT_TOKEN, {'{'}
                {'\n  '}server: <span className="text-[#fc6a5d]">{"'https://app.calab.ru'"}</span>,{'\n'}
                {'}'});{'\n'}
                <span className="text-[#ff7ab2]">await</span> bot.commands([{'{ '}name: <span className="text-[#fc6a5d]">{"'echo'"}</span>, description: <span className="text-[#fc6a5d]">{"'Repeat the text'"}</span>
                {' }'}]);{'\n\n'}
                <span className="text-[#7f8c98]">{'// every message from someone else'}</span>
                {'\n'}bot.on(<span className="text-[#fc6a5d]">{"'message'"}</span>, (m) =&gt; bot.reply(m, m.content));{'\n'}
                <span className="text-[#7f8c98]">{'// "/echo hi" → "hi"'}</span>
                {'\n'}bot.on(<span className="text-[#fc6a5d]">{"'command'"}</span>, (c) =&gt; bot.reply(c, c.args));{'\n\n'}
                <span className="text-[#ff7ab2]">await</span> bot.start();
              </code>
            </pre>
          </Frame>
        }
      />

      <section id="self-hosted" aria-labelledby="self-hosted-title" className="surface-alt bg-bg-alt py-20 sm:py-28">
        <Container>
          <Intro id="self-hosted-title" icon={Server} center {...t.selfhost} />
          <ol className="mt-12 grid gap-4 md:grid-cols-3 md:gap-6">
            {(['server', 'install', 'invite'] as const).map((id, i) => (
              <li key={id} className="rounded-[20px] border border-line bg-card p-6 sm:p-8">
                <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-accent-strong text-[15px] font-semibold text-white">
                  {i + 1}
                </span>
                <h3 className="mt-4 text-[21px] leading-7 font-semibold tracking-tight">
                  <span className="sr-only">{fmt(t.selfhost.step, { n: i + 1 })} </span>
                  {t.selfhost.steps[id].title}
                </h3>
                <p className="mt-2 text-[15px] leading-6 text-pretty text-fg-2">{t.selfhost.steps[id].text}</p>
                {id === 'server' && (
                  <pre className="mt-4 overflow-x-auto rounded-lg bg-code px-3 py-2 font-mono text-[13px] leading-5">
                    <code>infra/docker/deploy.sh</code>
                  </pre>
                )}
              </li>
            ))}
          </ol>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card icon={Lock} {...t.selfhost.security.tls} />
            <Card icon={ShieldCheck} {...t.selfhost.security.data} />
            <Card icon={Globe} {...t.selfhost.security.network} />
            <Card icon={KeyRound} {...t.selfhost.security.roles} />
          </ul>
        </Container>
      </section>
    </div>
  );
}
