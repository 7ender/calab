import { AudioLines, Globe, MessagesSquare, MonitorUp, Server, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Section, SectionHeading, ThemedImage } from './ui';

type Feature = {
  icon: LucideIcon;
  title: string;
  text: ReactNode;
  shot?: { name: string; alt: string };
  extra?: ReactNode;
};

const features: Feature[] = [
  {
    icon: AudioLines,
    title: 'Голос без эха и шума',
    text: 'Активация голосом или push-to-talk. Шумоподавление RNNoise и эхоподавление AEC3 — чисто даже без наушников. Opus 16–64 кбит/с, в паузах — около 1 кбит/с.',
    shot: { name: 'voice', alt: 'Выбор режима микрофона: активация голосом или push-to-talk' },
  },
  {
    icon: MonitorUp,
    title: 'Стрим экрана в AV1',
    text: '720p, 1080p или исходное разрешение. Статичный текст и код — 20–300 кбит/с, поэтому экран читается и на мобильном интернете. До трёх стримов в комнате.',
    shot: { name: 'stream', alt: 'Голосовая комната «Переговорка» с участниками и идущим стримом экрана с меткой LIVE' },
  },
  {
    icon: MessagesSquare,
    title: 'Чат как в Telegram',
    text: 'Файлы, реакции, ответы, закрепы, упоминания и поиск. У каждой голосовой комнаты есть свой чат.',
    shot: { name: 'chat', alt: 'Лента сообщений: форматирование, упоминание @here и поле ввода' },
  },
  {
    icon: ShieldCheck,
    title: 'Роли, права и гостевые ссылки',
    text: 'Права на уровне пространства и комнаты. Гость входит по ссылке без аккаунта и видит только свою комнату.',
    shot: { name: 'guests', alt: 'Создание гостевой ссылки: срок действия, лимит переходов, вход без аккаунта' },
  },
  {
    icon: Globe,
    title: 'Работает за VPN и файрволом',
    text: 'Если UDP закрыт, медиа переходит на TCP, а затем на TURN/TLS через порт 443 — трафик выглядит как обычный HTTPS. При обрыве связь восстанавливается без выхода из комнаты.',
    extra: (
      <ol aria-label="Порядок подключения" className="flex flex-wrap items-center gap-2 text-[13px] leading-5">
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
    icon: Server,
    title: 'Ваш сервер, ваши данные',
    text: 'Caddy, LiveKit, API на Go, Postgres и Valkey в одном Docker Compose. Сообщения, файлы и медиа не покидают вашу инфраструктуру. Kubernetes — следующий шаг.',
    extra: (
      <pre className="overflow-x-auto rounded-lg bg-code px-4 py-3 font-mono text-[13px] leading-5">
        <code>
          <span className="text-fg-2 select-none">$ </span>docker compose up -d
        </code>
      </pre>
    ),
  },
];

const inspirations = [
  { name: 'Discord', text: 'Структура: пространства, голосовые и текстовые комнаты, роли.' },
  { name: 'Telegram', text: 'Удобные чаты: ответы, реакции, файлы, поиск.' },
  { name: 'Zoom', text: 'Стабильный коннект: подстройка под канал и переподключение без выхода.' },
];

export function Features() {
  return (
    <Section id="features" labelledBy="features-title" alt>
      <SectionHeading
        id="features-title"
        eyebrow="Возможности"
        title="Голос, экран и чат в одном окне"
        lead="Зашли в комнату одним кликом — и говорите. Всё остальное под рукой."
      />
      <ul className="mt-12 grid gap-4 sm:mt-16 md:grid-cols-2 md:gap-6">
        {features.map((f) => (
          <li key={f.title} className="flex flex-col overflow-hidden rounded-[20px] border border-line bg-card">
            <div className="flex flex-1 flex-col p-6 sm:p-8">
              <f.icon aria-hidden="true" className="size-7 text-accent" strokeWidth={1.75} />
              <h3 className="mt-4 text-[21px] leading-7 font-semibold tracking-tight">{f.title}</h3>
              <p className="mt-2 text-[15px] leading-6 text-pretty text-fg-2">{f.text}</p>
              {f.extra && <div className="mt-auto pt-6">{f.extra}</div>}
            </div>
            {f.shot && (
              <div className="px-6 sm:px-8">
                <div className="overflow-hidden rounded-t-[10px] border border-b-0 border-line">
                  <ThemedImage name={f.shot.name} alt={f.shot.alt} width={660} height={400} />
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-16 sm:mt-20">
        <h3 className="text-center text-[21px] leading-7 font-semibold tracking-tight">Чем вдохновлялись</h3>
        <dl className="mx-auto mt-6 grid max-w-[960px] gap-6 text-center md:grid-cols-3 md:gap-8">
          {inspirations.map((i) => (
            <div key={i.name}>
              <dt className="text-[17px] leading-6 font-semibold">{i.name}</dt>
              <dd className="mt-1 text-[15px] leading-6 text-pretty text-fg-2">{i.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}
