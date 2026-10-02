'use client';
import { useRef } from 'react';
const lines = ['M2 8 Q8 0 16 6 T32 6 T48 6 T64 6 T80 6 T96 6 T112 6 T128 6 T144 6 T160 6 T178 6', 'M2 8 Q75 0 130 6 Q159 15 105 11 Q99 4 178 6', 'M2 8 Q90 1 178 5'];
export function HeroDiscover({ label }: { label: string }) {
 const path = useRef<SVGPathElement>(null); const index = useRef(0);
 const draw = () => { const el = path.current; if (!el) return; index.current++; el.setAttribute('d', lines[index.current % lines.length] ?? lines[0] ?? ''); el.getAnimations().forEach((a) => { a.cancel(); }); el.animate([{strokeDashoffset:1},{strokeDashoffset:0}], {duration:500,easing:'cubic-bezier(.65,0,.35,1)',fill:'forwards'}); };
 return <a className="hero-discover" href="#features" onPointerEnter={draw} onFocus={draw}><span className="discover-label">{label}<svg viewBox="0 0 180 14" preserveAspectRatio="none" aria-hidden="true"><path ref={path} d={lines[0]} pathLength="1" /></svg></span><span className="discover-arrow" aria-hidden="true">{[0,1].map((i) => <span className="discover-arrow-wrap" key={i}><svg viewBox="0 0 16 18"><path d="M6 1h4v9l3-3 3 3-8 8-8-8 3-3 3 3Z" /></svg></span>)}</span></a>;
}
