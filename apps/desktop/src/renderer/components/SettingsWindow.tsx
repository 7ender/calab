import * as DialogP from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import type { LucideIcon } from 'lucide-react';
import { Search, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '../i18n';
import { searchSettings, type SettingsEntry } from './settingsSearch';
import { IconButton, cx } from './ui';

export interface SettingsSection {
  id: string;
  label: string;
  icon: LucideIcon;
  content: ReactNode;
  /** Red label (e.g. «Удалить пространство»). */
  destructive?: boolean;
}

/**
 * Collects the searchable labels of every mounted section: elements marked with
 * `data-settings-label` (components/ui.tsx Row, Card titles, custom rows), optionally with
 * `data-settings-hint`. Index-based keys stay valid while the panels stay mounted.
 */
function harvest(root: HTMLElement, sections: SettingsSection[]): SettingsEntry[] {
  const out: SettingsEntry[] = [];
  for (const s of sections) {
    const panel = root.querySelector<HTMLElement>(`[data-settings-panel="${CSS.escape(s.id)}"]`);
    if (!panel) continue;
    panel.querySelectorAll<HTMLElement>('[data-settings-label]').forEach((el, n) => {
      out.push({ key: `${s.id}:${n}`, section: s.id, label: el.textContent.trim(), hint: el.dataset['settingsHint'] });
    });
  }
  return out;
}

const sameEntries = (a: SettingsEntry[], b: SettingsEntry[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Arrow keys between the buttons of a list (search results). */
function arrowNav(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = items[e.key === 'ArrowDown' ? i + 1 : i - 1];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

/**
 * System-Settings-like window (docs/08 «UX-правила», docs/09 #18): 920×640 (shrinks with the
 * window), a search field and the list of sections with icons on the left, the selected
 * section on the right as card groups («label left — control right»). Esc closes (or clears
 * the search first). While searching, every section is mounted (hidden) so its row labels can
 * be matched; picking a result opens the section and highlights the row.
 */
export function SettingsWindow({
  title,
  sections,
  initial,
  onClose,
  footer,
  titleIcon,
}: {
  title: string;
  /** Glyph before the title (room: # / speaker; workspace: its initials). */
  titleIcon?: ReactNode;
  sections: SettingsSection[];
  initial?: string | undefined;
  onClose: () => void;
  /** Extra items under the section list (e.g. «Выйти»). */
  footer?: ReactNode;
}): ReactNode {
  const [value, setValue] = useState(initial && sections.some((s) => s.id === initial) ? initial : (sections[0]?.id ?? ''));
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<SettingsEntry[]>([]);
  const [hit, setHit] = useState<string | null>(null);
  const panels = useRef<HTMLDivElement>(null);
  const results = useRef<HTMLElement>(null);
  const searching = query.trim() !== '';

  // Harvest labels while searching; sections render asynchronously (queries), so watch the DOM.
  useLayoutEffect(() => {
    const root = panels.current;
    if (!searching || !root) return;
    const update = (): void => setEntries((prev) => {
      const next = harvest(root, sections);
      return sameEntries(prev, next) ? prev : next;
    });
    update();
    let raf = 0;
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    });
    mo.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [searching, sections]);

  const groups = useMemo(() => (searching ? searchSettings(sections, entries, query) : []), [searching, sections, entries, query]);

  // Live preview: while the selected section has no matches, the right pane shows the first
  // matching one (System Settings does the same); picking a result makes it the selection.
  const firstSection = groups[0]?.section;
  const tab = searching && firstSection && !groups.some((g) => g.section === value) ? firstSection : value;
  const current = sections.find((s) => s.id === tab);

  // The highlighted row (data-settings-hit): scrolled into view after its section is shown.
  useEffect(() => {
    const root = panels.current;
    if (!root) return;
    root.querySelectorAll('[data-settings-hit]').forEach((el) => el.removeAttribute('data-settings-hit'));
    if (!hit || !searching) return;
    const [section, n] = hit.split(':');
    const panel = root.querySelector<HTMLElement>(`[data-settings-panel="${CSS.escape(section ?? '')}"]`);
    const label = panel?.querySelectorAll<HTMLElement>('[data-settings-label]')[Number(n)];
    const row = label?.closest<HTMLElement>('[data-settings-row]') ?? label;
    if (!row) return;
    row.setAttribute('data-settings-hit', 'true');
    row.scrollIntoView({ block: 'nearest' });
  }, [hit, searching, tab]);

  const openSection = (id: string): void => {
    setValue(id);
    setHit(null);
  };
  const jump = (e: SettingsEntry): void => {
    setValue(e.section);
    setHit(e.key);
  };
  const first = (): void => {
    const g = groups[0];
    if (!g) return;
    const row = g.rows[0];
    if (row) jump(row);
    else openSection(g.section);
  };

  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // Focus the window itself: no ring on a section opened with the mouse, and the
            // search field (first tabbable) is one Tab away.
            e.preventDefault();
            if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus();
          }}
          onEscapeKeyDown={(e) => {
            // Esc clears the search first (macOS search fields), then closes the window.
            if (query) {
              e.preventDefault();
              setQuery('');
              setHit(null);
            }
          }}
          // Centred while the window is tall enough; in a short window (960×600) the sheet hangs
          // 46 px from the top — below the 38 px title bar, like a macOS sheet — and shrinks to
          // 100vh − 62 px (16 px bottom margin). Not centred then, hence data-layout-anchor.
          data-layout-anchor=""
          className="mat-sheet anim-in fixed left-1/2 top-[max(46px,calc(50vh-320px))] z-[var(--z-modal)] flex h-[min(640px,calc(100vh-62px))] w-[min(920px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-[var(--radius-panel)] focus:outline-none"
        >
          <Tabs.Root value={tab} onValueChange={openSection} orientation="vertical" className="flex min-w-0 flex-1">
            <div className="mat-sidebar flex w-[220px] shrink-0 flex-col gap-2 border-r border-line p-2 max-[1000px]:w-[200px]">
              <DialogP.Title className="flex min-w-0 items-center gap-2 px-2 pt-2 text-body font-semibold text-fg">
                {titleIcon}
                <span className="min-w-0 truncate" title={title}>
                  {title}
                </span>
              </DialogP.Title>
              <label className="relative flex items-center">
                <Search className="pointer-events-none absolute left-2 size-3.5 text-muted" aria-hidden />
                <input
                  type="search"
                  role="searchbox"
                  aria-label={t('settings.search')}
                  placeholder={t('common.search')}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHit(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      first();
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      results.current?.querySelector<HTMLElement>('button')?.focus();
                    }
                  }}
                  className="selectable h-7 w-full min-w-0 rounded-[var(--radius-control)] border border-line bg-elev pl-7 pr-2 text-body text-fg shadow-[var(--shadow-card)] placeholder:text-muted focus-visible:outline-offset-0 [&::-webkit-search-cancel-button]:hidden"
                />
              </label>
              {searching ? (
                <nav ref={results} aria-label={t('settings.searchResults')} className="flex min-h-0 flex-col gap-px overflow-y-auto" onKeyDown={arrowNav}>
                  {groups.length === 0 ? <p className="px-2 py-2 text-body text-muted">{t('settings.searchNone')}</p> : null}
                  {groups.map((g) => {
                    const s = sections.find((x) => x.id === g.section);
                    if (!s) return null;
                    return (
                      <div key={g.section} className="flex flex-col gap-px">
                        <button
                          type="button"
                          onClick={() => openSection(s.id)}
                          aria-current={tab === s.id && !hit ? 'true' : undefined}
                          className={cx(
                            'flex h-8 items-center gap-2.5 rounded-[var(--radius-control)] px-2 text-left text-body hover:bg-hover',
                            tab === s.id && !hit ? 'bg-active' : '',
                            s.destructive ? 'text-danger-text' : 'text-fg',
                          )}
                        >
                          <s.icon className="size-4 shrink-0" aria-hidden />
                          <span className="min-w-0 truncate">{s.label}</span>
                        </button>
                        {g.rows.map((r) => (
                          <button
                            key={r.key}
                            type="button"
                            onClick={() => jump(r)}
                            aria-current={hit === r.key ? 'true' : undefined}
                            title={r.label}
                            className={cx(
                              'flex min-h-7 items-center rounded-[var(--radius-control)] py-1 pl-[34px] pr-2 text-left text-body text-muted hover:bg-hover hover:text-fg',
                              hit === r.key ? 'bg-active text-fg' : '',
                            )}
                          >
                            <span className="min-w-0 truncate">{r.label}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </nav>
              ) : (
                <Tabs.List aria-label={title} className="flex min-h-0 flex-col gap-px overflow-y-auto">
                  {sections.map((s) => (
                    <Tabs.Trigger
                      key={s.id}
                      value={s.id}
                      className={cx(
                        'flex h-8 shrink-0 items-center gap-2.5 rounded-[var(--radius-control)] px-2 text-left text-body',
                        'hover:bg-hover data-[state=active]:bg-accent-strong data-[state=active]:text-accent-fg data-[state=active]:hover:bg-accent-strong',
                        s.destructive ? 'text-danger-text' : 'text-fg',
                      )}
                    >
                      <s.icon className="size-4 shrink-0" aria-hidden />
                      <span className="min-w-0 truncate">{s.label}</span>
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>
              )}
              {footer ? <div className="mt-auto flex flex-col gap-px border-t border-line pt-2">{footer}</div> : null}
            </div>
            <div className="flex min-w-0 flex-1 flex-col bg-[var(--color-sheet-pane)]">
              <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line pl-6 pr-3">
                <h2 className="truncate text-headline font-semibold">{current?.label}</h2>
                <IconButton label={t('settings.close')} shortcut="Esc" size="sm" onClick={onClose}>
                  <X className="size-4" aria-hidden />
                </IconButton>
              </div>
              <div ref={panels} className="flex min-h-0 flex-1 flex-col">
                {sections.map((s) => (
                  <Tabs.Content
                    key={s.id}
                    value={s.id}
                    data-settings-panel={s.id}
                    forceMount={searching ? true : undefined}
                    className="min-h-0 flex-1 overflow-y-auto px-6 py-5 focus-visible:-outline-offset-2 data-[state=inactive]:hidden"
                  >
                    <div className="mx-auto flex max-w-[640px] flex-col gap-6">{s.content}</div>
                  </Tabs.Content>
                ))}
              </div>
            </div>
          </Tabs.Root>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

/** Sidebar footer item (not a section), e.g. «Выйти». */
export function SettingsAction({ label, icon: Icon, onClick, destructive }: { label: string; icon: LucideIcon; onClick: () => void; destructive?: boolean }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx('flex h-8 items-center gap-2.5 rounded-[var(--radius-control)] px-2 text-left text-body hover:bg-hover', destructive ? 'text-danger-text' : 'text-fg')}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {label}
    </button>
  );
}
