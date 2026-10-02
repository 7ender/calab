'use client';
import { useState } from 'react';
import { CardStickers } from './card-stickers';
export function PeopleCollage({ labels }: { labels: string[] }) {
  const [active, setActive] = useState<number | null>(null);
  return <div className="people-scene interactive-collage" data-active={active ?? ''} onPointerLeave={() => { setActive(null); }}>
    {[0, 1].map((index) => <button type="button" key={index} className={`collage-card collage-card-${index}`} aria-label={labels[index]} aria-pressed={active === index} onPointerEnter={() => { setActive(index); }} onFocus={() => { setActive(index); }} onBlur={() => { setActive(null); }} onClick={() => { setActive(active === index ? null : index); }}>
      <CardStickers active={active === index} />
      <span className="photo-card-surface"><span className="collage-photo" style={{ backgroundPosition: index === 0 ? 'left center' : 'right center' }} />
      <span className="collage-caption">{labels[index]}<span aria-hidden="true">↗</span></span>
      </span>
    </button>)}
    <button type="button" className="collage-sticker" aria-label="Calab" aria-pressed={active === 2} onPointerEnter={() => { setActive(2); }} onFocus={() => { setActive(2); }} onBlur={() => { setActive(null); }} onClick={() => { setActive(active === 2 ? null : 2); }}><img src="/editorial/conversation-stickers.webp" width={520} height={433} alt="" /></button>
  </div>;
}
