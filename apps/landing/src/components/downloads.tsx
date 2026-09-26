import { Laptop, Monitor, Terminal, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { APP_URL, DOWNLOADS, REPO_URL, repoFile } from '@/lib/site';
import { DownloadPrimary } from './download-primary';
import { Button, Section, SectionHeading } from './ui';

// Direct links to the stable latest/ names (no directory listing, no redirect hop).
const platforms: {
  icon: LucideIcon;
  name: string;
  variants: string;
  format: string;
  note: ReactNode;
  files: { label: string; href: string }[];
}[] = [
  {
    icon: Laptop,
    name: 'macOS',
    variants: 'Apple Silicon · Intel',
    format: 'DMG, macOS 12 и новее',
    note: 'Подписано Developer ID и нотаризовано Apple — открывается без предупреждений.',
    files: [
      { label: 'Apple Silicon', href: DOWNLOADS.macArm64 },
      { label: 'Intel', href: DOWNLOADS.macX64 },
    ],
  },
  {
    icon: Monitor,
    name: 'Windows',
    variants: 'x64',
    format: 'Установщик .exe, Windows 10 и 11',
    note: 'Сборка пока без подписи: при первом запуске SmartScreen покажет «Неизвестный издатель» → «Подробнее» → «Выполнить в любом случае».',
    files: [{ label: 'Скачать .exe', href: DOWNLOADS.win }],
  },
  {
    icon: Terminal,
    name: 'Linux',
    variants: 'AppImage · deb',
    format: 'x64',
    note: (
      <>
        AppImage перед запуском сделайте исполняемым: <code className="font-mono text-[13px]">chmod +x</code>.
      </>
    ),
    files: [
      { label: 'AppImage', href: DOWNLOADS.appImage },
      { label: '.deb', href: DOWNLOADS.deb },
    ],
  },
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
      <DownloadPrimary />
      <ul className="mx-auto mt-10 grid max-w-[960px] gap-4 sm:mt-12 md:grid-cols-3 md:gap-6">
        {platforms.map((p) => (
          <li key={p.name} className="flex flex-col items-center rounded-[20px] border border-line bg-card p-6 text-center sm:p-8">
            <p.icon aria-hidden="true" className="size-8 text-fg" strokeWidth={1.5} />
            <h3 className="mt-4 text-[21px] leading-7 font-semibold tracking-tight">{p.name}</h3>
            <p className="mt-1 text-[15px] leading-6 text-fg">{p.variants}</p>
            <p className="text-[14px] leading-5 text-fg-2">{p.format}</p>
            <p className="mt-4 text-[13px] leading-5 text-pretty text-fg-2">{p.note}</p>
            <div className="mt-auto flex w-full gap-2 pt-6">
              {p.files.map((f) => (
                <Button key={f.href} href={f.href} variant="secondary" className="min-w-0 flex-1 px-4">
                  {f.label}
                  <span className="sr-only"> — {p.name}</span>
                </Button>
              ))}
            </div>
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
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <span className="text-[14px] leading-5 text-fg-2">Что нового:</span>
        <Button href={repoFile('CHANGELOG.md')} variant="secondary" size="sm">
          Список изменений
        </Button>
        <Button href={`${REPO_URL}/releases`} variant="secondary" size="sm">
          Релизы на GitHub
        </Button>
      </div>
    </Section>
  );
}
