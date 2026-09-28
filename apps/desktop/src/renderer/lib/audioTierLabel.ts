import { audioTierKbps, type AudioTierKbps } from '@calaba/protocol';
import { t } from '../i18n';
import type { MessageKey } from '../i18n/types';

const KEYS: Record<AudioTierKbps, MessageKey> = { 8: 'audioTier.8', 16: 'audioTier.16', 32: 'audioTier.32', 64: 'audioTier.64' };

/** The word for a voice bitrate («Низкое / Нормальное / Хорошее / Отличное»); no numbers in the UI (docs/02 «Битрейт»). */
export function audioTierLabel(kbps: number): string {
  return t(KEYS[audioTierKbps(kbps)]);
}
