import { Laptop, Monitor, Terminal, type LucideIcon } from 'lucide-react';
import type { Dict } from '@/i18n';
import { rich } from '@/lib/rich';
import { APP_URL, DOWNLOADS, REPO_URL, repoFile } from '@/lib/site';
import { DownloadPrimary } from './download-primary';
import { Button, Section, SectionHeading } from './ui';

// Direct links to the stable latest/ names (no directory listing, no redirect hop).
const platforms: {
  id: keyof Dict['downloads']['platforms'];
  icon: LucideIcon;
  name: string;
  variants: string;
  files: { label: string | ((t: Dict['downloads']) => string); href: string }[];
}[] = [
  {
    id: 'mac',
    icon: Laptop,
    name: 'macOS',
    variants: 'Apple Silicon · Intel',
    files: [
      { label: 'Apple Silicon', href: DOWNLOADS.macArm64 },
      { label: 'Intel', href: DOWNLOADS.macX64 },
    ],
  },
  {
    id: 'win',
    icon: Monitor,
    name: 'Windows',
    variants: 'x64',
    files: [{ label: (t) => t.platforms.win.file, href: DOWNLOADS.win }],
  },
  {
    id: 'linux',
    icon: Terminal,
    name: 'Linux',
    variants: 'AppImage · deb',
    files: [
      { label: 'AppImage', href: DOWNLOADS.appImage },
      { label: '.deb', href: DOWNLOADS.deb },
    ],
  },
];

export function Downloads({ t }: { t: Dict['downloads'] }) {
  return (
    <Section id="download" labelledBy="download-title" alt>
      <SectionHeading id="download-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
      <DownloadPrimary t={t.primary} />
      <ul className="mx-auto mt-10 grid max-w-[960px] gap-4 sm:mt-12 md:grid-cols-3 md:gap-6">
        {platforms.map((p) => (
          <li key={p.id} className="flex flex-col items-center rounded-[20px] border border-line bg-card p-6 text-center sm:p-8">
            <p.icon aria-hidden="true" className="size-8 text-fg" strokeWidth={1.5} />
            <h3 className="mt-4 text-[21px] leading-7 font-semibold tracking-tight">{p.name}</h3>
            <p className="mt-1 text-[15px] leading-6 text-fg">{p.variants}</p>
            <p className="text-[14px] leading-5 text-fg-2">{t.platforms[p.id].format}</p>
            <p className="mt-4 text-[13px] leading-5 text-pretty text-fg-2">
              {rich(t.platforms[p.id].note, { code: <code className="font-mono text-[13px]">chmod +x</code> })}
            </p>
            <div className="mt-auto flex w-full gap-2 pt-6">
              {p.files.map((f) => (
                <Button key={f.href} href={f.href} variant="secondary" size="card" className="min-w-0 flex-1">
                  {typeof f.label === 'string' ? f.label : f.label(t)}
                  <span className="sr-only"> — {p.name}</span>
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-center text-[15px] leading-6 text-pretty text-fg-2">
        {rich(t.web, {
          link: (
            <a href={APP_URL} className="link">
              {t.webLink}
            </a>
          ),
        })}
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <span className="text-[14px] leading-5 text-fg-2">{t.whatsNew}</span>
        <Button href={repoFile('CHANGELOG.md')} variant="secondary" size="sm">
          {t.changelog}
        </Button>
        <Button href={`${REPO_URL}/releases`} variant="secondary" size="sm">
          {t.releases}
        </Button>
      </div>
    </Section>
  );
}
