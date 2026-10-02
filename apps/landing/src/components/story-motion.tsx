"use client";

import { useEffect } from 'react';

/** One-shot reveals: no scroll handlers, animation loop or hidden video decoding. */
export function StoryMotion() {
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (preference.matches || !('IntersectionObserver' in window)) return;
    const nodes = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.12 });
    for (const node of nodes) {
      if (node.getBoundingClientRect().top < window.innerHeight) continue;
      node.classList.add('reveal-ready');
      observer.observe(node);
    }
    const stop = () => { observer.disconnect(); nodes.forEach((node) => { node.classList.remove('reveal-ready'); }); };
    preference.addEventListener('change', stop);
    return () => { stop(); preference.removeEventListener('change', stop); };
  }, []);
  return null;
}
