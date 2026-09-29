import type { Sticker } from '@calaba/protocol';
import { memo, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { cx } from '../../../components/ui';
import { t } from '../../../i18n';
import { useMobile } from '../../../lib/mobile';
import type { StickerPlace } from '../../../lib/stickers';
import { suggestStickers, usableWorkspaces } from '../../../lib/stickerSuggest';
import { useMediaQuery } from '../../../lib/useMediaQuery';
import { loadMyStickers } from '../../../services/stickers';
import { useStickers } from '../../../stores/stickers';
import { useWorkspaces } from '../../../stores/workspaces';
import { StickerImage } from './StickerImage';

/** Tiles: 64 px on the desktop, 56 px on a phone; the sticker sits with a 4 px inset. */
const TILE = 64;
const TILE_MOBILE = 56;
const INSET = 4;

/** The composer forwards its field's keys here first; true = the strip took the key. */
export interface StickerSuggestHandle {
  onKey: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * «Стикеры по эмодзи» (docs/08 «Композер — подсказка стикеров», like Telegram): the composer
 * holds exactly one emoji → the stickers carrying it in a strip above the field, recently sent
 * first. Focus stays in the field: → enters the strip (nothing is highlighted before, so Enter
 * still sends the emoji as text), ←/→ move, Enter sends the highlighted sticker, Esc hides the
 * strip. Subscribed to the stores by this emoji only (a shallow list), not to the field's text.
 */
export const StickerSuggest = memo(function StickerSuggest({
  emoji,
  place,
  me,
  onSend,
  onDismiss,
  ref,
}: {
  emoji: string;
  place: StickerPlace;
  me: string;
  onSend: (s: Sticker) => void;
  onDismiss: () => void;
  ref: Ref<StickerSuggestHandle>;
}): ReactNode {
  const loaded = useStickers((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void loadMyStickers();
  }, [loaded]);
  // Where packs may be sent here (roles of me / the DM peer): a primitive, stable across voice states.
  const wsKey = useWorkspaces((s) => usableWorkspaces(Object.keys(s.byId), place, me, (w, u) => s.byId[w]?.members[u]?.role));
  const list = useStickers(
    useShallow((s) => {
      if (!wsKey) return [];
      const allowed = wsKey.split(',');
      return suggestStickers(
        s.installed.filter((p) => allowed.includes(p.workspaceId)),
        emoji,
        s.recent,
      );
    }),
  );
  const mobile = useMobile();
  const reduce = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [sel, setSel] = useState(-1);
  const row = useRef<HTMLDivElement>(null);
  const idx = sel < list.length ? sel : -1;

  useEffect(() => {
    if (idx < 0) return;
    row.current?.children[idx]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [idx]);

  useImperativeHandle(
    ref,
    () => ({
      onKey: (e) => {
        if (!list.length || e.nativeEvent.isComposing) return false;
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setSel(Math.min(list.length - 1, idx + 1));
          return true;
        }
        if (e.key === 'ArrowLeft' && idx >= 0) {
          e.preventDefault();
          setSel(idx - 1);
          return true;
        }
        if (e.key === 'Enter' && !e.shiftKey && idx >= 0) {
          e.preventDefault();
          const s = list[idx];
          if (s) onSend(s);
          return true;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          onDismiss();
          return true;
        }
        return false;
      },
    }),
    [list, idx, onSend, onDismiss],
  );

  if (!list.length) return null;
  const tile = mobile ? TILE_MOBILE : TILE;
  return (
    <div
      className="mat-popover dense anim-in absolute inset-x-0 bottom-full z-[var(--z-popover)] mb-2 overflow-hidden rounded-[var(--radius-panel)]"
      data-testid="sticker-suggest"
    >
      <div
        ref={row}
        role="listbox"
        aria-orientation="horizontal"
        aria-label={t('stk.suggest', { emoji })}
        className="flex gap-1 overflow-x-auto p-1.5 scrollbar-none"
        onWheel={(e) => {
          // A vertical wheel scrolls the row sideways (a mouse without a horizontal wheel).
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {list.map((s, i) => (
          <SuggestTile key={s.id} sticker={s} size={tile} active={i === idx} reduce={reduce} onSend={onSend} />
        ))}
      </div>
    </div>
  );
});

/** One tile: an animated sticker plays only under the pointer or while highlighted (docs/14). */
const SuggestTile = memo(function SuggestTile({
  sticker,
  size,
  active,
  reduce,
  onSend,
}: {
  sticker: Sticker;
  size: number;
  active: boolean;
  reduce: boolean;
  onSend: (s: Sticker) => void;
}): ReactNode {
  const [hot, setHot] = useState(false);
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      tabIndex={-1}
      aria-label={t('stk.sticker', { emoji: sticker.emoji })}
      data-sticker-suggest
      // The field keeps the focus (and the keyboard on a phone).
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onSend(sticker)}
      onPointerEnter={() => setHot(true)}
      onPointerLeave={() => setHot(false)}
      className={cx('grid shrink-0 place-items-center rounded-[var(--radius-card)] hover:bg-hover', active && 'bg-[var(--color-fill)] ring-2 ring-inset ring-accent')}
      style={{ width: size, height: size }}
    >
      <StickerImage sticker={sticker} size={size - 2 * INSET} playing={sticker.animated && (hot || active) && !reduce} />
    </button>
  );
});
