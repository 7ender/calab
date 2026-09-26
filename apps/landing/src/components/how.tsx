import { Section, SectionHeading } from './ui';

const steps = [
  {
    title: 'Поднимите сервер',
    text: 'Linux-хост с Docker и доменом. Одна команда — и через минуту всё работает, сертификаты Let’s Encrypt выпускаются сами.',
  },
  {
    title: 'Установите приложение',
    text: 'macOS, Windows или Linux. Или просто откройте Calab в браузере — ничего ставить не нужно.',
  },
  {
    title: 'Пригласите команду',
    text: 'Отправьте ссылку-приглашение. Гостям на одну встречу аккаунт не нужен.',
  },
];

export function HowItWorks() {
  return (
    <Section id="how" labelledBy="how-title">
      <SectionHeading id="how-title" eyebrow="Как это работает" title="Три шага до первого созвона" />
      <ol className="mt-12 grid gap-4 sm:mt-16 md:grid-cols-3 md:gap-6">
        {steps.map((s, i) => (
          <li key={s.title} className="rounded-[20px] border border-line bg-card p-6 sm:p-8">
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-full bg-accent-tint text-[15px] font-semibold text-accent-text"
            >
              {i + 1}
            </span>
            <h3 className="mt-4 text-[21px] leading-7 font-semibold tracking-tight">
              <span className="sr-only">Шаг {i + 1}. </span>
              {s.title}
            </h3>
            <p className="mt-2 text-[15px] leading-6 text-pretty text-fg-2">{s.text}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
