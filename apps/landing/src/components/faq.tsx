import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { CONTACT_EMAIL } from '@/lib/site';
import { Section, SectionHeading } from './ui';

const faq: { q: string; a: ReactNode }[] = [
  {
    q: 'Что нужно для своего сервера?',
    a: 'Linux-хост с Docker, публичный IP и домен. Открытые порты: 80 и 443 (TCP и UDP), 7881/TCP, 7882/UDP. Ориентировочно для команды до 30 человек — 4 vCPU и 8 ГБ памяти; точнее зависит от числа одновременных стримов экрана.',
  },
  {
    q: 'Сколько трафика расходует Calab?',
    a: 'Голос — 16–64 кбит/с на говорящего (по умолчанию 32), в паузах около 1 кбит/с. Стрим статичного экрана — 20–300 кбит/с, потолок 1080p — 2 Мбит/с. Каждому зрителю сервер отдаёт качество под его канал.',
  },
  {
    q: 'Как обновляется приложение?',
    a: 'Десктоп обновляется сам при запуске. Сборка для macOS подписана и нотаризована Apple; для Windows пока без подписи, поэтому SmartScreen может предупредить. Веб-версия всегда свежая.',
  },
  {
    q: 'Как защищена связь?',
    a: 'API и сигнализация — по TLS, голос и видео — DTLS-SRTP. Сообщения и файлы хранятся только на вашем сервере. Сквозного шифрования пока нет: медиа проходит через ваш медиасервер.',
  },
  {
    q: 'Работает ли через VPN и корпоративный файрвол?',
    a: 'Да. Если UDP недоступен, клиент переключается на TCP, а затем на TURN/TLS через порт 443 — для сети это обычный HTTPS.',
  },
  {
    q: 'Какие ограничения у текущей версии?',
    a: 'Рассчитана на 20–30 человек онлайн одновременно и до трёх стримов экрана в комнате. Горизонтальное масштабирование — в планах.',
  },
  {
    q: 'Как получить коммерческую лицензию?',
    a: (
      <>
        Напишите на{' '}
        <a href={`mailto:${CONTACT_EMAIL}`} className="link">
          {CONTACT_EMAIL}
        </a>
        : расскажите о компании и сценарии — пришлём условия.
      </>
    ),
  },
];

export function Faq() {
  return (
    <Section id="faq" labelledBy="faq-title" alt>
      <SectionHeading id="faq-title" eyebrow="Вопросы" title="Коротко о главном" />
      <div className="mx-auto mt-12 max-w-[760px] divide-y divide-line border-y border-line sm:mt-16">
        {faq.map((f) => (
          <details key={f.q} className="group">
            <summary className="flex min-h-14 cursor-pointer items-center justify-between gap-4 rounded-md py-4 text-[17px] leading-6 font-semibold">
              <h3>{f.q}</h3>
              <ChevronDown
                aria-hidden="true"
                className="chevron size-5 shrink-0 text-fg-2 motion-safe:transition-transform motion-safe:duration-150"
                strokeWidth={1.75}
              />
            </summary>
            <p className="pb-5 text-[15px] leading-6 text-pretty text-fg-2">{f.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}
