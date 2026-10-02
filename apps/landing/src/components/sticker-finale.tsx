import { CursorStickerTrail } from './cursor-sticker-trail';
import type { Locale } from '@/i18n';
const copy = {
  ru: ['Ну что, на связи?', 'Начать разговор'],
  en: ['Ready to connect?', 'Start a conversation'],
  es: ['¿Nos conectamos?', 'Iniciar conversación'],
  zh: ['准备好连接了吗？', '开始交流'],
};
export function StickerFinale({ locale }: { locale: Locale }) {
  const t = copy[locale];
  return <section className="sticker-finale">
    <div className="finale-copy"><h2>{t[0]}</h2><a className="kinetic-button" href="#download"><span className="kinetic-arrow" aria-hidden="true">→</span><span className="kinetic-label">{t[1]}</span><span className="kinetic-arrow kinetic-arrow-end" aria-hidden="true">→</span></a></div>
    <CursorStickerTrail />
  </section>;
}
