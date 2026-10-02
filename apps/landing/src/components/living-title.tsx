'use client';
import { useEffect, useRef } from 'react';

/** Reference proximity contract, with a finite animation loop instead of an idle ticker. */
export function LivingTitle({ lines }: { lines: string[] }) {
 const root = useRef<HTMLHeadingElement>(null);
 useEffect(() => {
   const node = root.current; if (!node) return;
   const media = window.matchMedia('(pointer: fine) and (prefers-reduced-motion: no-preference)');
   const glyphs = [...node.querySelectorAll<HTMLElement>('[data-glyph]')].map((el) => {
     const accent = !!el.closest('.title-line-accent'); const rest = accent ? 400 : 900;
     return { el, accent, rest, near: accent ? 900 : 100, x: 0, y: 0, value: rest };
   });
   let frame = 0;
   let disposed = false;
   const measure = () => { glyphs.forEach((g) => { const b = g.el.parentElement?.getBoundingClientRect(); if (b) { g.x = b.left + b.width / 2; g.y = b.top + b.height / 2; } }); };
   let pointerX = 0;
   let pointerY = 0;
   const tick = () => {
     frame = 0;
     glyphs.forEach((g) => {
       const strength = Math.max(0, 1 - Math.hypot(pointerX - g.x, pointerY - g.y) / 400);
       const weight = g.rest + (g.near - g.rest) * strength;
       if (Math.abs(weight - g.value) < .5) return;
       g.value = weight;
       g.el.style.fontVariationSettings = `"wght" ${weight.toFixed(2)}`;
     });
   };
   const pointer = (e: PointerEvent) => {
     if (!media.matches || e.pointerType !== 'mouse') return;
     pointerX = e.clientX;
     pointerY = e.clientY;
     if (!frame) frame = requestAnimationFrame(tick);
   };
   const reset = () => { cancelAnimationFrame(frame); frame = 0; glyphs.forEach((g) => { g.value = g.rest; g.el.style.removeProperty('font-variation-settings'); }); };
   measure();
   const observer = new ResizeObserver(measure); observer.observe(node);
   document.fonts.ready.then(() => { if (!disposed) measure(); }).catch(() => {});
   window.addEventListener('pointermove', pointer, { passive: true });
   window.addEventListener('scroll', measure, { passive: true });
   window.addEventListener('resize', measure);
   node.addEventListener('animationend', measure);
   media.addEventListener('change', reset);
   return () => { disposed = true; reset(); observer.disconnect(); window.removeEventListener('pointermove', pointer); window.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); node.removeEventListener('animationend', measure); media.removeEventListener('change', reset); };
 }, []);
 return <h1 ref={root} id="hero-title" className="story-hero-title living-title" aria-label={lines.join(' ')}>
 {lines.map((line,index) => <span key={line} className={`living-line ${index === 1 ? 'title-line-accent' : ''}`} aria-hidden="true">{Array.from(line.replace(/\.$/, '').toUpperCase()).map((char,i) => <span className="glyph-slot" data-char={char === ' ' ? '\u00a0' : char} key={i} style={{animationDelay:`${.15 + index * .14 + i * .025}s`}}><span data-glyph>{char === ' ' ? '\u00a0' : char}</span></span>)}</span>)}
 </h1>;
}
