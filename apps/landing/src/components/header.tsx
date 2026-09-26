import { APP_URL, REPO_URL } from '@/lib/site';
import { Button, Container } from './ui';

const nav = [
  { href: '#features', label: 'Возможности' },
  { href: '#how', label: 'Как начать' },
  { href: '#download', label: 'Скачать' },
  { href: '#pricing', label: 'Лицензия' },
  { href: '#faq', label: 'Вопросы' },
  { href: REPO_URL, label: 'GitHub' },
];

export function Header() {
  return (
    <header className="glass sticky top-0 z-10 border-b border-line">
      <a
        href="#main"
        className="sr-only rounded-md bg-card-raised text-[14px] shadow-window focus:not-sr-only focus:absolute focus:top-2 focus:left-4 focus:z-20 focus:px-4 focus:py-2"
      >
        Перейти к содержимому
      </a>
      <Container className="flex h-13 items-center justify-between gap-4">
        <a href="#top" className="flex items-center gap-2 rounded-md" aria-label="Calab — наверх">
          <img src="/icon-192.png" alt="" width={28} height={28} className="size-7" />
          <span className="text-[17px] font-semibold tracking-tight">Calab</span>
        </a>
        <nav aria-label="Разделы" className="hidden md:block">
          <ul className="flex items-center gap-6 text-[14px] text-fg-2">
            {nav.map((n) => (
              <li key={n.href}>
                <a href={n.href} className="rounded-md hover:text-fg motion-safe:transition-colors">
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <Button href={APP_URL} size="sm" variant="secondary">
          Открыть в браузере
        </Button>
      </Container>
    </header>
  );
}
