'use client';

import { useEffect, useRef, useState } from 'react';
import type { Locale } from '@/i18n';
import { LOCALE_INFO } from '@/i18n/locales';
import { SCREENS } from '@/lib/screens';
const sceneColors = ['#b4d88a', '#4976ff', '#ff9f67', '#da9ee5'];
const scrollStickers = ['sticker-video.webp', 'conversation-stickers.webp', 'sticker-chat.webp', 'sticker-faq.webp', 'sticker-tasks.webp', 'sticker-chat.webp', 'sticker-tasks.webp', 'access-sticker.webp'];
const scenes = ['voice', 'chat', 'calendar', 'kanban'] as const;
const sceneLabels = {
  ru: ['Звонки и видео', 'Чаты', 'Календарь', 'Задачи'],
  en: ['Calls & video', 'Chats', 'Calendar', 'Tasks'],
  es: ['Llamadas y vídeo', 'Chats', 'Calendario', 'Tareas'],
  zh: ['通话与视频', '聊天', '日历', '任务'],
};

export function ProductPreview({ locale, label }: { locale: Locale; label: string }) {
  const labels = sceneLabels[locale];
  const [selected, setSelected] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const media = window.matchMedia('(min-width: 1024px) and (pointer: fine) and (prefers-reduced-motion: no-preference)');
    let frame = 0;
    let observing = false;
    let lastSticker = -1;
    // Sample once per mount: scrolling back retraces the same composition.
    const positions = scenes.map(() => ({
      x: (Math.random() < .5 ? -1 : 1) * (65 + Math.random() * 115),
      y: (Math.random() - .5) * 150,
      angle: (Math.random() - .5) * 14,
      exitSide: Math.random() < .5 ? -1 : 1,
    }));
    const update = () => {
      frame = 0;
      const box = node.getBoundingClientRect();
      const travel = Math.max(1, box.height - window.innerHeight);
      const progress = Math.max(0, Math.min(1, -box.top / travel));
      setSelected(Math.min(scenes.length - 1, Math.round(progress * (scenes.length - 1))));
      node.style.setProperty('--scene-progress', String(progress));
      const bucket = Math.min(7, Math.floor(progress * 8));
      if (bucket !== lastSticker && box.top <= 0 && box.bottom > window.innerHeight) {
        lastSticker = bucket;
        const stickers = node.querySelectorAll<HTMLElement>('.scroll-sticker');
        stickers.forEach((sticker) => { sticker.getAnimations().forEach((a) => { a.cancel(); }); });
        const sticker = stickers[bucket];
        if (sticker) {
          const side = Math.random() < .5 ? 'left' : 'right';
          sticker.style.left = side === 'left' ? `${Math.random() * 3}%` : 'auto';
          sticker.style.right = side === 'right' ? `${Math.random() * 3}%` : 'auto';
          sticker.style.top = `${15 + Math.random() * 50}%`;
          const angle = Math.random() * 30 - 15;
          sticker.animate([
            { opacity: 0, transform: `rotate(${angle - 10}deg) scale(.5)` },
            { opacity: 1, transform: `rotate(${angle}deg) scale(1)`, offset: .15 },
            { opacity: 1, transform: `rotate(${angle}deg) scale(1)`, offset: .7 },
            { opacity: 0, transform: `translateY(18px) rotate(${angle + 8}deg) scale(.9)` },
          ], { duration: 1900, easing: 'ease-out' });
        }
      }
      node.querySelectorAll<HTMLElement>('.showcase-slide').forEach((slide, index) => {
        const position = positions[index];
        if (!position) return;
        const phase = progress * (scenes.length - 1) - index;
        const waiting = Math.min(1, Math.max(0, -phase));
        const departure = Math.min(1, Math.max(0, phase));
        const x = position.x * waiting + position.exitSide * window.innerWidth * 1.3 * departure;
        const y = position.y * waiting + departure * position.y * .5;
        const angle = position.angle * (waiting + departure);
        slide.style.transform = `translate(${x}px, ${y}px) rotate(${angle}deg) scale(${1 - waiting * .08})`;
        slide.style.zIndex = String(scenes.length - index);
      });
    };
    const scroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const stop = () => {
      window.removeEventListener('scroll', scroll);
      window.removeEventListener('resize', scroll);
      window.cancelAnimationFrame(frame);
      frame = 0;
      node.querySelectorAll('.scroll-sticker').forEach((sticker) => { sticker.getAnimations().forEach((a) => { a.cancel(); }); });
    };
    const observer = new IntersectionObserver(([entry]) => {
      stop();
      if (entry?.isIntersecting && media.matches) {
        window.addEventListener('scroll', scroll, { passive: true });
        window.addEventListener('resize', scroll);
        scroll();
      }
    });
    const configure = () => {
      stop();
      if (observing) observer.unobserve(node);
      observing = media.matches;
      node.classList.toggle('is-pinned', media.matches);
      if (media.matches) observer.observe(node);
      else {
        node.querySelectorAll<HTMLElement>('.showcase-slide').forEach((slide) => { ['transform', 'opacity', 'visibility', 'z-index'].forEach((property) => { slide.style.removeProperty(property); }); });
        stage.current?.scrollTo({ left: 0, behavior: 'instant' });
        setSelected(0);
      }
    };
    configure();
    media.addEventListener('change', configure);
    return () => { stop(); observer.disconnect(); media.removeEventListener('change', configure); node.classList.remove('is-pinned'); };
  }, []);
  const choose = (index: number) => {
    const node = root.current;
    if (node?.classList.contains('is-pinned')) {
      const box = node.getBoundingClientRect();
      const progress = index / (scenes.length - 1);
      window.scrollTo({ top: window.scrollY + box.top + progress * (box.height - window.innerHeight), behavior: 'instant' });
    } else {
      const row = stage.current;
      const slide = row?.children[index] as HTMLElement | undefined;
      const first = row?.firstElementChild as HTMLElement | null;
      if (row && slide && first) row.scrollTo({ left: slide.offsetLeft - first.offsetLeft, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
    setSelected(index);
  };
  return <div id="showcase" ref={root} className="product-preview scroll-showcase">
    <div className="showcase-sticky">
      {scrollStickers.map((src, i) => <img key={i} className="scroll-sticker" src={`/editorial/${src}`} width={160} height={160} alt="" aria-hidden="true" />)}
      <div ref={stage} className="showcase-stage" role="region" aria-label={label} tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          choose(Math.max(0, Math.min(scenes.length - 1, selected + (event.key === 'ArrowRight' ? 1 : -1))));
        }}
        onScroll={() => {
          const row = stage.current;
          if (!row || root.current?.classList.contains('is-pinned')) return;
          const first = row.firstElementChild as HTMLElement | null;
          if (!first) return;
          let nearest = 0; let distance = Infinity;
          Array.from(row.children).forEach((child, index) => {
            const delta = Math.abs((child as HTMLElement).offsetLeft - first.offsetLeft - row.scrollLeft);
            if (delta < distance) { nearest = index; distance = delta; }
          });
          setSelected(nearest);
        }}>
        {scenes.map((scene, index) => {
          const size = SCREENS[scene];
          const base = `/screens/${LOCALE_INFO[locale].lang}/${scene}`;
          return <div key={scene} className={`showcase-slide scene-${scene} ${index === selected ? 'is-active' : ''}`} style={{ '--scene-color': sceneColors[index] } as React.CSSProperties} aria-hidden={index !== selected}>
            <img src={`${base}.webp`} srcSet={`${base}-720.webp 720w, ${base}.webp ${size.width}w, ${base}@2x.webp ${size.width * 2}w`} sizes="(min-width: 1680px) 1600px, 96vw" width={size.width} height={size.height} alt={`${label}: ${labels[index]}`} loading="lazy" />
          </div>;
        })}
      </div>
      <div className="showcase-navigation">
        <div role="group" aria-label={label} className="showcase-dots">{labels.map((text, index) => <button key={text} type="button" aria-label={text} aria-pressed={selected === index} onClick={() => { choose(index); }}><span style={{ background: sceneColors[index] }} /></button>)}</div>
        <span className="showcase-count" aria-hidden="true">0{selected + 1} / 04</span>
      </div>
    </div>
  </div>;
}
