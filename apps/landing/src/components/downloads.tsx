import { Download, Laptop, Monitor, Terminal, type LucideIcon } from 'lucide-react';
import { APP_URL, DOWNLOAD_URL } from '@/lib/site';
import { Button, Section, SectionHeading } from './ui';

const platforms: { icon: LucideIcon; name: string; variants: string; format: string }[] = [
  { icon: Laptop, name: 'macOS', variants: 'Apple Silicon · Intel', format: 'DMG, macOS 12 и новее' },
  { icon: Monitor, name: 'Windows', variants: 'x64', format: 'Установщик .exe, Windows 10 и 11' },
  { icon: Terminal, name: 'Linux', variants: 'AppImage · deb', format: 'x64' },
];

export function Downloads() {
  return (
    <Section id="download" labelledBy="download-title" alt>
      <SectionHeading
        id="download-title"
        eyebrow="Скачать"
        title="Приложение для всех платформ"
        lead="Клиент на Electron: глобальные хоткеи, push-to-talk в фоне, стрим любого окна."
      />
      <ul className="mx-auto mt-12 grid max-w-[960px] gap-4 sm:mt-16 md:grid-cols-3 md:gap-6">
        {platforms.map((p) => (
          <li key={p.name} className="flex flex-col items-center rounded-[20px] border border-line bg-card p-6 text-center sm:p-8">
            <p.icon aria-hidden="true" className="size-8 text-fg" strokeWidth={1.5} />
            <h3 className="mt-4 text-[21px] leading-7 font-semibold tracking-tight">{p.name}</h3>
            <p className="mt-1 text-[15px] leading-6 text-fg">{p.variants}</p>
            <p className="text-[14px] leading-5 text-fg-2">{p.format}</p>
            <Button href={DOWNLOAD_URL} className="mt-6 w-full">
              <Download aria-hidden="true" className="size-4" strokeWidth={2} />
              Скачать<span className="sr-only"> для {p.name}</span>
            </Button>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-center text-[15px] leading-6 text-fg-2">
        Или откройте{' '}
        <a href={APP_URL} className="link">
          веб-версию
        </a>{' '}
        — в Chrome, Edge, Safari или Firefox.
      </p>
      <div className="mx-auto mt-6 max-w-[720px] rounded-xl border border-line bg-card px-4 py-3 text-[14px] leading-5 text-fg-2 sm:px-6 sm:py-4">
        <p>
          <strong className="font-semibold text-fg">Сборки пока не подписаны.</strong> macOS: Системные настройки →
          Конфиденциальность и безопасность → «Всё равно открыть». Windows: в окне SmartScreen — «Подробнее» → «Выполнить в
          любом случае».
        </p>
      </div>
    </Section>
  );
}
