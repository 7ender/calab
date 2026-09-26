import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Calab',
    short_name: 'Calab',
    description: 'Голосовые комнаты, чат и стрим экрана для команды — на вашем сервере',
    start_url: '/',
    display: 'browser',
    background_color: '#0e0e10',
    theme_color: '#0e0e10',
    lang: 'ru',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
