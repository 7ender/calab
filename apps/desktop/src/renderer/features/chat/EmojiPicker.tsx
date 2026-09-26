import * as Popover from '@radix-ui/react-popover';
import { Clock3, Search } from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { useChatView } from './chatView';
import { EMOJI_GROUPS, searchEmoji } from './emoji';

const COLS = 9;

/**
 * Lightweight emoji picker (no dependency): search by name, recent, 8 groups with a tab row.
 * Arrow keys move inside the grid (roving focus), Enter picks, Esc closes.
 */
export function EmojiPicker({ onPick, label, children }: { onPick: (emoji: string) => void; label: string; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip label={label}>
        <Popover.Trigger asChild>{children}</Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={10}
          collisionPadding={8}
          aria-label={t('chat.emoji')}
          className="mat-popover anim-in z-[var(--z-popover)] flex h-[360px] w-[340px] flex-col overflow-hidden rounded-[var(--radius-panel)]"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <PickerBody
            onPick={(e) => {
              useChatView.getState().pushRecent(e);
              onPick(e);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PickerBody({ onPick }: { onPick: (emoji: string) => void }): ReactNode {
  const [q, setQ] = useState('');
  const recent = useChatView((s) => s.recentEmoji);
  const scroller = useRef<HTMLDivElement>(null);
  const sections = useMemo(() => {
    if (q.trim()) return [{ id: 'search', label: t('chat.emojiFound'), list: searchEmoji(q) }];
    return [...(recent.length ? [{ id: 'recent', label: t('chat.emojiRecent'), list: recent }] : []), ...EMOJI_GROUPS];
  }, [q, recent]);

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = Array.from(scroller.current?.querySelectorAll<HTMLButtonElement>('button[data-emoji]') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, i + step))];
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Search className="size-4 shrink-0 text-faint" aria-hidden />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              scroller.current?.querySelector<HTMLButtonElement>('button[data-emoji]')?.focus();
            }
          }}
          placeholder={t('chat.emojiSearch')}
          aria-label={t('chat.emojiSearch')}
          className="h-10 min-w-0 flex-1 bg-transparent text-[13px] text-fg placeholder:text-faint focus:outline-none focus-visible:outline-none"
        />
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" onKeyDown={onGridKey}>
        {sections.map((s) => (
          <section key={s.id} id={`emoji-${s.id}`} aria-label={s.label}>
            <h3 className="sticky top-0 z-[1] bg-[var(--color-popover-solid)] px-1 pb-1 pt-2 text-[12px] font-semibold text-muted">{s.label}</h3>
            {s.list.length === 0 ? <p className="px-1 py-4 text-center text-[13px] text-muted">{t('chat.emojiNone')}</p> : null}
            <div className="grid grid-cols-9">
              {s.list.map((e, i) => (
                <button
                  key={`${s.id}-${e}-${i}`}
                  type="button"
                  data-emoji
                  tabIndex={s === sections[0] && i === 0 ? 0 : -1}
                  onClick={() => onPick(e)}
                  aria-label={e}
                  className="grid size-9 place-items-center rounded-[var(--radius-control)] text-[22px] leading-none hover:bg-hover focus-visible:bg-hover focus-visible:outline-offset-[-2px]"
                >
                  {e}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      {!q.trim() ? (
        <nav className="flex shrink-0 items-center justify-between border-t border-line px-2 py-1" aria-label={t('chat.emojiGroups')}>
          {recent.length ? (
            <GroupTab label={t('chat.emojiRecent')} onClick={() => jumpTo(scroller.current, 'recent')}>
              <Clock3 className="size-4" aria-hidden />
            </GroupTab>
          ) : null}
          {EMOJI_GROUPS.map((g) => (
            <GroupTab key={g.id} label={g.label} onClick={() => jumpTo(scroller.current, g.id)}>
              <span className="text-[16px] leading-none grayscale-[35%]">{g.icon}</span>
            </GroupTab>
          ))}
        </nav>
      ) : null}
    </>
  );
}

function jumpTo(scroller: HTMLDivElement | null, id: string): void {
  const el = scroller?.querySelector<HTMLElement>(`#emoji-${id}`);
  if (scroller && el) scroller.scrollTo({ top: el.offsetTop - scroller.offsetTop });
}

function GroupTab({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cx('grid size-8 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-hover hover:text-fg')}
    >
      {children}
    </button>
  );
}
