import type { CSSProperties, ReactNode } from 'react';
import { stickerSrc } from '@/lib/stickers';
import { cx } from './ui';

type Placement = { asset: string; pos: CSSProperties; angle: number; delay: number; size?: 'sm' };

/**
 * Deterministic per-topic sticker sets: each screenshot shows its own stickers, peeking from behind the frame edges.
 * Positions are fixed (no randomness at render, so no hydration drift); the pop-out is a one-shot CSS transition
 * driven by `.is-visible` from StoryMotion (transform/opacity only).
 */
const SETS = {
  voice: [
    { asset: 'headphones', pos: { top: 'var(--peek-v)', right: '7%' }, angle: 12, delay: 120 },
    { asset: 'video', pos: { bottom: 'var(--peek-v)', left: 'var(--peek-side)' }, angle: -14, delay: 260 },
    { asset: 'highfive', pos: { top: '34%', right: 'var(--peek-side)' }, angle: 9, delay: 400, size: 'sm' },
  ],
  chat: [
    { asset: 'chat', pos: { top: 'var(--peek-v)', left: '9%' }, angle: -10, delay: 120 },
    { asset: 'coffee', pos: { bottom: 'var(--peek-v)', right: '8%' }, angle: 11, delay: 260 },
    { asset: 'lightning', pos: { top: '40%', left: 'var(--peek-side)' }, angle: -8, delay: 400, size: 'sm' },
  ],
  calendar: [
    { asset: 'calendar', pos: { top: 'var(--peek-v)', right: '10%' }, angle: 10, delay: 120 },
    { asset: 'fire', pos: { bottom: 'var(--peek-v)', left: '4%' }, angle: -12, delay: 260 },
    { asset: 'faq', pos: { top: '30%', right: 'var(--peek-side)' }, angle: 8, delay: 400, size: 'sm' },
  ],
  kanban: [
    { asset: 'tasks', pos: { top: 'var(--peek-v)', left: '12%' }, angle: -9, delay: 120 },
    { asset: 'lightning', pos: { bottom: 'var(--peek-v)', right: '6%' }, angle: 13, delay: 260 },
    { asset: 'highfive', pos: { top: '44%', left: 'var(--peek-side)' }, angle: -10, delay: 400, size: 'sm' },
  ],
  // Small thumbnails in the capability cards: one sticker each.
  voiceCard: [{ asset: 'headphones', pos: { top: '-26px', right: '10px' }, angle: 10, delay: 100, size: 'sm' }],
  chatCard: [{ asset: 'chat', pos: { top: '-26px', right: '10px' }, angle: -8, delay: 100, size: 'sm' }],
  meetingsCard: [{ asset: 'calendar', pos: { top: '-26px', right: '10px' }, angle: 9, delay: 100, size: 'sm' }],
  boardsCard: [{ asset: 'tasks', pos: { top: '-26px', right: '10px' }, angle: -9, delay: 100, size: 'sm' }],
  botsCard: [{ asset: 'fire', pos: { top: '-26px', right: '10px' }, angle: 8, delay: 100, size: 'sm' }],
  companyCard: [{ asset: 'pricing', pos: { top: '-26px', right: '10px' }, angle: -8, delay: 100, size: 'sm' }],
} as const satisfies Record<string, readonly Placement[]>;

export type StickerSet = keyof typeof SETS;

export function ShotStage({ set, className, children }: { set: StickerSet; className?: string; children: ReactNode }) {
  const placements: readonly Placement[] = SETS[set];
  return (
    <div className={cx('shot-stage', className)} data-reveal>
      <span className="shot-stickers" aria-hidden="true">
        {placements.map((p) => (
          <img key={p.asset} className={p.size === 'sm' ? 'is-sm' : undefined} src={stickerSrc(p.asset)} alt="" width={112} height={112} loading="lazy" decoding="async" draggable={false}
            style={{ ...p.pos, '--a': `${p.angle}deg`, '--d': `${p.delay}ms` } as CSSProperties} />
        ))}
      </span>
      <div className="shot-stage-body">{children}</div>
    </div>
  );
}
