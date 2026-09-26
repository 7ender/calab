import { CONTACT_EMAIL, GPTUNNEL_URL, REPO_URL, repoFile } from '@/lib/site';
import { Container } from './ui';

const links = [
  { href: REPO_URL, label: 'GitHub' },
  { href: repoFile('LICENSE'), label: 'Лицензия' },
  { href: repoFile('COMMERCIAL-LICENSE.md'), label: 'Коммерческая лицензия' },
  { href: repoFile('SECURITY.md'), label: 'Безопасность' },
  { href: repoFile('TRADEMARKS.md'), label: 'Товарные знаки' },
  { href: `mailto:${CONTACT_EMAIL}`, label: CONTACT_EMAIL },
];

export function Footer() {
  return (
    <footer className="border-t border-line py-10">
      <Container className="flex flex-col gap-6 text-[14px] leading-5 text-fg-2 md:flex-row md:items-center md:justify-between">
        <nav aria-label="Документы">
          <ul className="flex flex-wrap gap-x-6 gap-y-3">
            {links.map((l) => (
              <li key={l.label}>
                <a href={l.href} className="rounded-md hover:text-fg">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <p>
          © 2026 GPTunneL ·{' '}
          <a href={GPTUNNEL_URL} className="text-accent-text hover:underline">
            Powered by GPTunneL
          </a>
        </p>
      </Container>
    </footer>
  );
}
