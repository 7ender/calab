'use client';
import { useEffect, useRef } from 'react';

/** Anchor connections to the measured nodes, including after font/layout changes. */
export function ControlConnections() {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    const map = svg?.parentElement;
    const hub = map?.querySelector<HTMLElement>('.control-hub');
    if (!svg || !map || !hub) return;
    const nodes = Array.from(map.querySelectorAll<HTMLElement>('.control-node'));
    let frame = 0;
    const measure = () => {
      frame = 0;
      const area = map.getBoundingClientRect();
      if (!area.width || !area.height) return;
      const center = hub.getBoundingClientRect();
      const radius = center.width / 2;
      const cx = center.left - area.left + radius;
      const cy = center.top - area.top + center.height / 2;
      svg.setAttribute('viewBox', `0 0 ${area.width} ${area.height}`);
      nodes.forEach((node, index) => {
        const box = (node.querySelector('h3') ?? node).getBoundingClientRect();
        const left = index < 2;
        const x = (left ? box.right + 12 : box.left - 12) - area.left;
        const y = box.top - area.top + box.height / 2;
        const endY = cy + (index % 2 === 0 ? -1 : 1) * radius * .4;
        const endX = cx + (left ? -1 : 1) * Math.sqrt(radius ** 2 - (radius * .4) ** 2);
        const midX = (x + endX) / 2;
        svg.querySelector(`[data-line="${index}"]`)?.setAttribute('d', `M${x} ${y} C${midX} ${y} ${midX} ${endY} ${endX} ${endY}`);
        const dot = svg.querySelector(`[data-dot="${index}"]`);
        dot?.setAttribute('cx', String(x));
        dot?.setAttribute('cy', String(y));
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    [map, hub, ...nodes, ...nodes.flatMap((node) => Array.from(node.querySelectorAll('h3')))].forEach((node) => { observer.observe(node); });
    schedule();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  return <svg ref={ref} className="control-connections" aria-hidden="true">
    {[0, 1, 2, 3].map((index) => <g key={index}><path data-line={index} /><circle data-dot={index} r="3" /></g>)}
  </svg>;
}
