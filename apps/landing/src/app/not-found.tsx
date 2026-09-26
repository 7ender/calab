import Link from 'next/link';
import { Container } from '@/components/ui';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center">
      <Container className="text-center">
        <h1 className="text-[32px] leading-10 font-semibold tracking-tight">Страница не найдена</h1>
        <p className="mt-3 text-[17px] leading-7 text-fg-2">Возможно, ссылка устарела.</p>
        <Link href="/" className="mt-6 inline-block text-[17px] text-accent-text hover:underline">
          На главную
        </Link>
      </Container>
    </main>
  );
}
