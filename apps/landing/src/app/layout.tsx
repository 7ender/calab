import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SITE_URL } from '@/lib/site';
import './globals.css';

const title = 'Calab — голос, чат и стрим для команды';
const description =
  'Голосовые комнаты, чат и стрим экрана для команды на вашем сервере. Без эха и шума, AV1-стрим от 20 кбит/с, работает за VPN и файрволом. macOS, Windows, Linux и браузер.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title,
  description,
  applicationName: 'Calab',
  alternates: { canonical: '/' },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'Calab',
    locale: 'ru_RU',
    title,
    description,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Calab — окно приложения с чатом команды' }],
  },
  twitter: { card: 'summary_large_image', title, description, images: ['/og.png'] },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0e10' },
  ],
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-dvh text-fg">{children}</body>
    </html>
  );
}
