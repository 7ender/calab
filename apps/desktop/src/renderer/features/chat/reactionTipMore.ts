import { plural } from '../../i18n';

/**
 * The «and N more» tail of the reaction tooltip when fewer names are listed than the chip's
 * total `count` (the chip count is authoritative; a page cut or a stale count only
 * under-reports). '' when everyone fits.
 */
export function reactionTipMore(listed: number, count: number): string {
  const hidden = Math.max(0, count - listed);
  return hidden > 0 ? plural('chat.reactionOthers', hidden) : '';
}
