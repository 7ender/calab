'use client';
import type { ReactNode } from 'react';
import { useRef } from 'react';
const marks = [
 'M2 8 Q35 1 66 6 T118 5',
 'M2 7 Q48 -1 79 6 Q101 14 62 10 Q58 3 118 6',
 'M2 7 Q7 1 13 6 T25 6 T37 6 T49 6 T61 6 T73 6 T85 6 T97 6 T118 6',
 'M2 5 Q54 9 117 3 M9 10 Q55 5 108 9',
];
let nextMark = 0;
export function DrawnNavLink({ href, current, children }: { href: string; current: boolean; children: ReactNode }) {
 const path = useRef<SVGPathElement>(null);
 const draw = () => {
   const el = path.current; if (!el) return;
   el.getAnimations().forEach((a) => { a.cancel(); });
   el.setAttribute('d', marks[nextMark++ % marks.length] ?? marks[0] ?? '');
   el.animate([{ strokeDashoffset: '1' }, { strokeDashoffset: '0' }], { duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 500, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' });
 };
 const erase = () => {
   const el = path.current; if (!el || current) return;
   const offset = getComputedStyle(el).strokeDashoffset;
   el.getAnimations().forEach((a) => { a.cancel(); });
   el.animate([{ strokeDashoffset: offset }, { strokeDashoffset: '-1' }], { duration: 500, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' });
 };
 return <a href={href} aria-current={current ? 'page' : undefined} className="nav-draw-link" onPointerEnter={draw} onPointerLeave={erase} onFocus={draw} onBlur={erase}>{children}<svg className="nav-underline" viewBox="0 0 120 12" preserveAspectRatio="none" aria-hidden="true"><path ref={path} d={marks[0]} pathLength="1" /></svg></a>;
}
