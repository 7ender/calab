import type { CSSProperties, ReactNode } from 'react';
import { stickerSrc } from '@/lib/stickers';
import { cx } from './ui';

/**
 * One topic sticker per screenshot. On wide screens it slides out from behind the frame towards the text column
 * and settles, fully visible, in the free space above or below the text (`v`); stacked (narrow) layouts show none.
 * The slide is a one-shot CSS transition driven by `.is-visible` from StoryMotion
 * (transform/opacity only, no scroll code). Fixed values: no hydration drift.
 */
const STICKER = {
  voice: { asset: 'headphones', v: 'top', angle: -10 },
  chat: { asset: 'chat', v: 'bottom', angle: 9 },
  calendar: { asset: 'calendar', v: 'top', angle: 8 },
  kanban: { asset: 'tasks', v: 'bottom', angle: -9 },
} as const satisfies Record<string, { asset: string; v: 'top' | 'bottom'; angle: number }>;

export type StickerSet = keyof typeof STICKER;

/** `side`: where the text column is relative to the screenshot. */
export function ShotStage({ set, side, className, children }: { set: StickerSet; side: 'left' | 'right'; className?: string; children: ReactNode }) {
  const s = STICKER[set];
  return (
    <div className={cx('shot-stage', className)} data-side={side} data-v={s.v} data-reveal>
      <span className="shot-stickers" aria-hidden="true">
        <img src={stickerSrc(s.asset)} alt="" width={128} height={128} loading="lazy" decoding="async" draggable={false} style={{ '--a': `${s.angle}deg` } as CSSProperties} />
      </span>
      <div className="shot-stage-body">{children}</div>
    </div>
  );
}
