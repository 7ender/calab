'use client';

import { ChevronDown, Globe } from 'lucide-react';
import { useEffect, useRef, type MouseEvent } from 'react';
import { LOCALE_INFO, LOCALE_STORAGE_KEY, LOCALES, localePath, type Locale } from '@/i18n/locales';

/**
 * Language pill in the header (ADR-0022 §3): a native <details> menu of plain links, so it works without JS.
 * With JS: remembers the explicit choice (read by the root redirect page), keeps the current #section,
 * closes on outside click / Escape.
 */
export function LocaleSwitcher({ locale, label }: { locale: Locale; label: string }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        el.open = false;
        el.querySelector('summary')?.focus();
      } else if (!el.contains(e.target as Node)) {
        el.open = false;
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);

  const choose = (l: Locale) => (e: MouseEvent<HTMLAnchorElement>) => {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, l);
    } catch {
      // storage blocked (private mode, policies): the link still navigates
    }
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    window.location.assign(localePath(l) + window.location.hash);
  };

  const current = LOCALE_INFO[locale];
  return (
    <details ref={ref} className="relative">
      <summary
        aria-label={`${label}: ${current.name}`}
        className="flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-line px-3 text-[14px] text-fg-2 select-none hover:text-fg motion-safe:transition-colors"
      >
        <Globe aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="sm:hidden">{current.short}</span>
        <span className="hidden sm:inline">{current.name}</span>
        <ChevronDown aria-hidden="true" className="chevron size-3.5 shrink-0 motion-safe:transition-transform" strokeWidth={2} />
      </summary>
      <ul className="absolute right-0 mt-2 min-w-40 rounded-xl border border-line bg-card-raised p-1 text-[14px] shadow-window">
        {LOCALES.map((l) => (
          <li key={l}>
            <a
              href={localePath(l)}
              hrefLang={LOCALE_INFO[l].lang}
              lang={LOCALE_INFO[l].lang}
              aria-current={l === locale ? 'page' : undefined}
              onClick={choose(l)}
              className={
                'flex h-9 items-center rounded-lg px-3 hover:bg-accent-tint ' +
                (l === locale ? 'font-semibold text-accent-text' : 'text-fg')
              }
            >
              {LOCALE_INFO[l].name}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
