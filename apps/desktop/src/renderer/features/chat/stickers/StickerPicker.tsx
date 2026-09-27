import { WorkspaceRole, type Sticker, type StickerPack } from '@calaba/protocol';
import { Clock3, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Spinner, Tip, cx } from '../../../components/ui';
import { plural, t } from '../../../i18n';
import { autoFocusAllowed } from '../../../lib/mobile';
import { coverOf, packUsable, resolveRecent, searchStickers, type StickerPlace } from '../../../lib/stickers';
import { installPack, loadMyStickers } from '../../../services/stickers';
import { useSession } from '../../../stores/session';
import { useStickers } from '../../../stores/stickers';
import { useWorkspaces } from '../../../stores/workspaces';
import { searchEmoji } from '../emoji';
import { StickerImage } from './StickerImage';

const COLS = 5;
const CELL = 64;
const IMG = 56;

/**
 * «Стикеры» tab of the emoji panel (ADR-0030, docs/08 «Стикеры»): search by emoji, recent,
 * my packs in my order (only those usable here), pack covers along the bottom. With nothing
 * usable: the packs of my workspaces to add. Grids render when their section nears the view.
 */
export function StickerPicker({ place, onSend }: { place: StickerPlace; onSend: (s: Sticker) => void }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const loaded = useStickers((s) => s.loaded);
  const installed = useStickers((s) => s.installed);
  const available = useStickers((s) => s.available);
  const recentIds = useStickers((s) => s.recent);
  const byId = useWorkspaces((s) => s.byId);
  const [q, setQ] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void loadMyStickers();
  }, []);

  const usable = useMemo(
    () => installed.filter((p) => p.stickers.length > 0 && packUsable(p, place, me, (ws, u) => byId[ws]?.members[u]?.role)),
    [installed, place, me, byId],
  );
  const addable = useMemo(
    () => available.filter((p) => p.stickers.length > 0 && packUsable(p, place, me, (ws, u) => byId[ws]?.members[u]?.role)),
    [available, place, me, byId],
  );
  const recent = useMemo(() => resolveRecent(recentIds, usable).slice(0, COLS * 2), [recentIds, usable]);
  const found = useMemo(() => (q.trim() ? searchStickers(usable, q, searchEmoji) : null), [q, usable]);
  // A guest of this workspace only looks at stickers (ADR-0030 §4).
  const guestHere = 'workspaceId' in place && byId[place.workspaceId]?.role === WorkspaceRole.GUEST;

  const onScroll = (): void => {
    const el = scroller.current;
    if (!el) return;
    let cur: string | null = null;
    for (const sec of Array.from(el.querySelectorAll<HTMLElement>('section[data-pack]'))) {
      if (sec.offsetTop - el.offsetTop <= el.scrollTop + 8) cur = sec.dataset['pack'] ?? null;
    }
    setActive(cur);
  };
  const jump = (id: string): void => {
    const el = scroller.current?.querySelector<HTMLElement>(`section[data-pack="${id}"]`);
    if (scroller.current && el) scroller.current.scrollTo({ top: el.offsetTop - scroller.current.offsetTop });
  };
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = Array.from(scroller.current?.querySelectorAll<HTMLButtonElement>('button[data-sticker-pick]') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
    if (i < 0 || !step) return;
    e.preventDefault();
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, i + step))];
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
  };

  if (guestHere) return <Note>{t('stk.guest')}</Note>;
  if (!loaded) {
    return (
      <div className="grid flex-1 place-items-center">
        <Spinner />
      </div>
    );
  }
  const nothing = usable.length === 0;
  return (
    <>
      {!nothing ? (
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-4 shrink-0 text-faint" aria-hidden />
          <input
            autoFocus={autoFocusAllowed()}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                scroller.current?.querySelector<HTMLButtonElement>('button[data-sticker-pick]')?.focus();
              }
            }}
            placeholder={t('stk.search')}
            aria-label={t('stk.search')}
            data-testid="sticker-search"
            className="h-10 min-w-0 flex-1 bg-transparent text-body text-fg placeholder:text-faint focus:outline-none focus-visible:outline-none"
          />
        </div>
      ) : null}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 pb-2" onScroll={onScroll} onKeyDown={onGridKey} data-testid="sticker-grid">
        {nothing ? (
          <div className="flex flex-col gap-3 py-3">
            <p className="px-1 text-center text-body text-muted">{addable.length === 0 && available.length + installed.length > 0 ? t('stk.noneHere') : t('stk.empty')}</p>
            {addable.length ? <Available packs={addable} /> : null}
          </div>
        ) : found ? (
          <Section id="search" label={t('stk.found')}>
            {found.length === 0 ? <p className="px-1 py-4 text-center text-body text-muted">{t('stk.none')}</p> : <Grid stickers={found} onSend={onSend} />}
          </Section>
        ) : (
          <>
            {recent.length ? (
              <Section id="recent" label={t('stk.recent')}>
                <Grid stickers={recent} onSend={onSend} />
              </Section>
            ) : null}
            {usable.map((p) => (
              <Section key={p.id} id={p.id} label={p.name} lazyRows={Math.ceil(p.stickers.length / COLS)}>
                <Grid stickers={p.stickers} onSend={onSend} />
              </Section>
            ))}
            {addable.length ? (
              <section className="-mx-3 px-3 pt-2">
                <h3 className="pb-1 text-caption font-semibold text-muted">{t('stk.available')}</h3>
                <Available packs={addable} />
              </section>
            ) : null}
          </>
        )}
      </div>
      {!nothing && !found ? (
        <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-line px-3 py-1" aria-label={t('stk.packs')}>
          {recent.length ? (
            <PackTab label={t('stk.recent')} active={(active ?? 'recent') === 'recent'} onClick={() => jump('recent')}>
              <Clock3 className="size-5" aria-hidden />
            </PackTab>
          ) : null}
          {usable.map((p, i) => {
            const c = coverOf(p);
            const on = active ? active === p.id : !recent.length && i === 0;
            return (
              <PackTab key={p.id} label={p.name} active={on} onClick={() => jump(p.id)}>
                {c ? <StickerImage sticker={c} size={24} /> : null}
              </PackTab>
            );
          })}
        </nav>
      ) : null}
    </>
  );
}

function Note({ children }: { children: ReactNode }): ReactNode {
  return <p className="grid flex-1 place-items-center px-6 text-center text-body text-muted">{children}</p>;
}

/** A pack's section: its grid renders once it nears the view (a placeholder of its height before). */
function Section({ id, label, lazyRows, children }: { id: string; label: string; lazyRows?: number; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(lazyRows === undefined || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const o = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        setSeen(true);
        o.disconnect();
      }
    }, { rootMargin: '200px 0px' });
    o.observe(el);
    return () => o.disconnect();
  }, [seen]);
  return (
    <section ref={ref} data-pack={id} aria-label={label} className="-mx-3 px-3">
      <h3 className="sticky top-0 z-[1] -mx-3 truncate bg-[var(--color-popover-solid)] px-3 pb-1 pt-2 text-caption font-semibold text-muted">{label}</h3>
      {seen ? children : <div style={{ height: (lazyRows ?? 1) * CELL }} aria-hidden />}
    </section>
  );
}

function Grid({ stickers, onSend }: { stickers: readonly Sticker[]; onSend: (s: Sticker) => void }): ReactNode {
  return (
    <div className="grid grid-cols-5">
      {stickers.map((s, i) => (
        <button
          key={`${s.id}-${i}`}
          type="button"
          data-sticker-pick
          tabIndex={i === 0 ? 0 : -1}
          onClick={() => onSend(s)}
          aria-label={t('stk.sticker', { emoji: s.emoji })}
          className="grid w-full min-w-0 place-items-center rounded-[var(--radius-card)] hover:bg-hover focus-visible:bg-hover focus-visible:outline-offset-[-2px]"
          style={{ height: CELL }}
        >
          <StickerImage sticker={s} size={IMG} />
        </button>
      ))}
    </div>
  );
}

function Available({ packs }: { packs: readonly StickerPack[] }): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <ul className="flex flex-col gap-1">
      {packs.map((p) => {
        const c = coverOf(p);
        return (
          <li key={p.id} className="flex items-center gap-3 rounded-[var(--radius-row)] px-1 py-1">
            {c ? <StickerImage sticker={c} size={36} /> : <span className="size-9" />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-medium text-fg">{p.name}</p>
              <p className="text-caption text-muted">{plural('stk.count', p.stickers.length, { n: p.stickers.length })}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              busy={busy === p.id}
              onClick={() => {
                setBusy(p.id);
                void installPack(p).finally(() => setBusy(null));
              }}
            >
              {t('stk.add')}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function PackTab({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-current={active || undefined}
        onClick={onClick}
        className={cx('relative grid size-8 shrink-0 place-items-center rounded-[var(--radius-icon)] hover:bg-hover hover:text-fg', active ? 'text-accent' : 'text-muted')}
      >
        {children}
        {active ? <span className="absolute inset-x-1.5 -bottom-1 h-0.5 rounded-full bg-accent" aria-hidden /> : null}
      </button>
    </Tip>
  );
}
