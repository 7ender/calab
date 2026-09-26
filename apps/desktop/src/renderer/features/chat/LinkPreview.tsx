import type { UnfurlResponse } from '@calaba/protocol';
import { useEffect, useState, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { isSafeHref } from '../../lib/markdown/parse';
import { platform } from '../../platform';
import { unfurl } from '../../services/chat';

/** Server-proxied images only: never load third-party hosts from the client (proto/unfurl.proto). */
const isProxied = (p: string): boolean => p.startsWith('/api/unfurl/image');

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Telegram-like link preview inside a bubble: accent bar, site, title, description, image. */
export function LinkPreview({ url }: { url: string }): ReactNode {
  const [card, setCard] = useState<UnfurlResponse | null>(null);
  useEffect(() => {
    let alive = true;
    void unfurl(url).then((c) => {
      if (alive) setCard(c);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  if (!card) return null;
  const href = card.url && isSafeHref(card.url) ? card.url : url;
  const image = card.imageUrl && isProxied(card.imageUrl) ? card.imageUrl : '';
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (isSafeHref(href)) void platform.app.openExternal(href);
      }}
      data-testid="link-preview"
      className="mt-1.5 flex min-w-0 max-w-[400px] rounded-[var(--radius-control)] border-l-[3px] border-[color:var(--bubble-accent)] bg-[color-mix(in_srgb,var(--bubble-accent)_10%,transparent)] py-1.5 pl-2 pr-2 hover:bg-[color-mix(in_srgb,var(--bubble-accent)_16%,transparent)]"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-semibold text-[color:var(--bubble-accent)]">{card.siteName || hostOf(href)}</span>
        {card.title ? <span className="line-clamp-2 text-body font-semibold leading-5 text-fg">{card.title}</span> : null}
        {card.description ? <span className="line-clamp-3 text-body leading-[18px] text-fg">{card.description}</span> : null}
        {image ? (
          <MediaImg
            path={image}
            alt=""
            loading="lazy"
            draggable={false}
            className="mt-1.5 block aspect-[1.91/1] w-full rounded-[var(--radius-control)] bg-[color-mix(in_srgb,var(--bubble-accent)_12%,transparent)] object-cover"
          />
        ) : null}
      </span>
    </a>
  );
}
