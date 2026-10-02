import type { Sticker } from '@calaba/protocol';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMediaUrl } from '../../../components/MediaImg';
import { cx } from '../../../components/ui';
import { t } from '../../../i18n';
import { createPlayback } from '../../../lib/stickerPlayback';
import { stickerBox } from '../../../lib/stickers';
import { builtinStickerUrl } from '../../../lib/builtinStickers';

/**
 * A sticker (ADR-0030 §8): the WebP through <img> (the browser decodes it), no background.
 * An animated one plays only while on screen, with the window shown, motion allowed and fewer
 * than MAX_PLAYING others playing; otherwise its first frame stands still on a <canvas>.
 */

const playback = createPlayback();
let nextId = 1;

// One IntersectionObserver for every animated sticker (the feed may hold dozens).
const targets = new Map<Element, number>();
let io: IntersectionObserver | null = null;
function observer(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  io ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      const id = targets.get(e.target);
      if (id !== undefined) playback.setVisible(id, e.isIntersecting);
    }
  });
  return io;
}

// The window shown and no reduced motion: the whole budget on or off (docs/14).
let envBound = false;
function bindEnvironment(): void {
  if (envBound || typeof document === 'undefined') return;
  envBound = true;
  const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const sync = (): void => playback.setEnabled(document.visibilityState === 'visible' && !motion?.matches);
  document.addEventListener('visibilitychange', sync);
  motion?.addEventListener('change', sync);
  sync();
}

function usePlaying(ref: React.RefObject<HTMLElement | null>, animated: boolean): boolean {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!animated || !el) return;
    bindEnvironment();
    const id = nextId++;
    playback.add(id, setPlaying);
    const o = observer();
    if (o) {
      targets.set(el, id);
      o.observe(el);
    } else {
      playback.setVisible(id, true);
    }
    return () => {
      o?.unobserve(el);
      targets.delete(el);
      playback.remove(id);
    };
  }, [ref, animated]);
  return playing;
}

// First frames, by media URL: drawn once per sticker, reused by every still copy.
const stills = new Map<string, Promise<ImageBitmap | null>>();
const STILLS_MAX = 200;
function firstFrame(src: string): Promise<ImageBitmap | null> {
  let p = stills.get(src);
  if (!p) {
    p = new Promise<ImageBitmap | null>((resolve) => {
      // A detached image is never painted, so it does not animate: its bitmap is frame 0.
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (typeof createImageBitmap !== 'function') {
          resolve(null);
          return;
        }
        createImageBitmap(img).then(resolve, () => resolve(null));
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
    stills.set(src, p);
    if (stills.size > STILLS_MAX) {
      const oldest = stills.keys().next().value;
      if (oldest !== undefined) stills.delete(oldest);
    }
  }
  return p;
}

/** The first frame of an animated WebP on a <canvas> (also the staged previews in settings). */
export function StickerStill({ src, width, height }: { src: string; width: number; height: number }): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    void firstFrame(src).then((bmp) => {
      const c = canvas.current;
      const ctx = c?.getContext('2d');
      if (!alive || !bmp || !c || !ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      c.dataset['drawn'] = '1'; // visual tests wait for the still frame
    });
    return () => {
      alive = false;
    };
  }, [src]);
  const dpr = typeof devicePixelRatio === 'number' ? Math.min(2, devicePixelRatio) : 1;
  return <canvas ref={canvas} width={Math.round(width * dpr)} height={Math.round(height * dpr)} style={{ width, height }} aria-hidden data-sticker-still />;
}

/**
 * `playing` given: the caller decides when an animated sticker plays (the picker — on hover /
 * focus only) and the shared budget is not used; omitted: the budget above decides.
 */
export function StickerImage({ sticker, size, className, playing: forced }: { sticker: Sticker; size: number; className?: string; playing?: boolean }): ReactNode {
  const box = stickerBox(sticker, size);
  const local = builtinStickerUrl(sticker);
  const remote = useMediaUrl(local ? undefined : sticker.url);
  const src = local ?? remote;
  const ref = useRef<HTMLSpanElement>(null);
  const budgeted = usePlaying(ref, sticker.animated && forced === undefined);
  const playing = forced ?? budgeted;
  const label = t('stk.sticker', { emoji: sticker.emoji });
  return (
    <span
      ref={ref}
      role="img"
      aria-label={label}
      className={cx('inline-grid shrink-0 place-items-center', className)}
      style={{ width: box.width, height: box.height }}
      data-sticker={sticker.id}
      data-playing={sticker.animated ? String(playing) : undefined}
    >
      {!src ? null : !sticker.animated || playing ? (
        <img src={src} alt="" width={box.width} height={box.height} draggable={false} decoding="async" className="size-full object-contain" />
      ) : (
        <StickerStill src={src} width={box.width} height={box.height} />
      )}
    </span>
  );
}
