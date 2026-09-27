import * as Popover from '@radix-ui/react-popover';
import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { t } from '../../i18n';
import { autoFocusAllowed, useMobile } from '../../lib/mobile';
import { Spinner, cx } from '../ui';
import {
  PICKER_DEBOUNCE_MS,
  PICKER_ROW_PX,
  PICKER_VIRTUAL_MIN,
  buildRows,
  moveActive,
  navCount,
  rowOfNav,
  type PickerGroup,
  type PickerItem,
  type PickerKey,
  type PickerRow,
} from './pickerModel';

/** Touch rows on the phone layout (HIG 44 px); the desktop list is 32 px (docs/08). */
const MOBILE_ROW_PX = 44;
const NAV_KEYS: ReadonlySet<string> = new Set<PickerKey>(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp']);

export interface PickerPanelProps<T extends PickerItem> {
  groups: readonly PickerGroup<T>[];
  /** Row content (avatar, name, marks…); `active` = keyboard / pointer highlight on the accent fill. */
  renderItem: (item: T, active: boolean) => ReactNode;
  onSelect: (item: T) => void;
  /** Esc in the field (the popover / dialog closes on its own; an inline host may need it). */
  onEscape?: () => void;
  /** Field placeholder and accessible name, e.g. «Имя, ник или email». */
  placeholder: string;
  /** Accessible name of the list. */
  label: string;
  /** Empty result text; default «Никого не найдено». */
  emptyText?: string;
  /**
   * Server search (new DM): called with the debounced query; the groups are then the server's
   * answer and are not filtered again on the client.
   */
  onQuery?: (query: string) => void;
  loading?: boolean;
  error?: string | null;
  /** Show group headers even when only one group has rows. */
  alwaysHeaders?: boolean;
  /** List height (px) on the desktop; the list never grows past it (see `fill`). */
  height?: number;
  /**
   * In a `Modal fill` (docs/09 #52): the list takes the height left in the dialog, down to its
   * bottom padding (`flex-1 min-h-0`), instead of stopping at `height` with room to spare;
   * a virtualized list starts from `height` and shrinks with a short window.
   */
  fill?: boolean;
  /** Focus the field on mount (never on a phone: no keyboard until a tap). */
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  testId?: string;
}

/**
 * The one list picker (docs/08 «Выбор участника»): a search field (case-insensitive, 150 ms
 * debounce) over grouped 32 px rows, ↑↓ / PgUp / PgDn move, Enter picks, Esc closes; virtualized
 * above 50 rows. Combobox + listbox semantics: the focus stays in the field, the active row is
 * aria-activedescendant. Used inline (new DM, room invite) and inside PickerPopover.
 */
export function PickerPanel<T extends PickerItem>({
  groups,
  renderItem,
  onSelect,
  onEscape,
  placeholder,
  label,
  emptyText,
  onQuery,
  loading = false,
  error = null,
  alwaysHeaders = false,
  height = 288,
  fill = false,
  autoFocus = true,
  inputRef,
  testId,
}: PickerPanelProps<T>): ReactNode {
  const listId = useId();
  const ownInput = useRef<HTMLInputElement>(null);
  const input = inputRef ?? ownInput;
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const mobile = useMobile();
  const rowPx = mobile ? MOBILE_ROW_PX : PICKER_ROW_PX;

  useEffect(() => {
    const next = text.trim();
    if (next === query) return;
    const timer = window.setTimeout(() => setQuery(next), next ? PICKER_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [text, query]);
  useEffect(() => {
    onQuery?.(query);
    // Only the query drives the server call; a new callback identity is not a new search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const rows = useMemo(() => buildRows(groups, query, { alwaysHeaders, serverFiltered: !!onQuery }), [groups, query, alwaysHeaders, onQuery]);
  const count = navCount(rows);
  // The highlight restarts at the top for every new query (derived, no effect round trip).
  const [act, setAct] = useState({ q: '', i: 0 });
  const active = count === 0 ? -1 : Math.min(act.q === query ? act.i : 0, count - 1);
  const activeRow = active >= 0 ? rowOfNav(rows, active) : -1;
  const activeItem = activeRow >= 0 ? rows[activeRow] : undefined;
  const optionId = (key: string): string => `${listId}-${key.replace(/[^\w-]/g, '_')}`;

  const virtual = rows.length > PICKER_VIRTUAL_MIN;
  const virtuoso = useRef<VirtuosoHandle>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeRow < 0) return;
    if (virtual) virtuoso.current?.scrollIntoView({ index: activeRow, behavior: 'auto' });
    else list.current?.querySelector(`[data-row="${activeRow}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeRow, virtual]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (NAV_KEYS.has(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      setAct({ q: query, i: moveActive(active, count, e.key as PickerKey) });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      // Enter right after typing: pick from what the debounced list will show.
      if (text.trim() !== query) {
        const now = buildRows(groups, text.trim(), { alwaysHeaders, serverFiltered: !!onQuery });
        const first = now.find((r) => r.kind === 'item' && r.nav === 0);
        if (first?.kind === 'item' && !onQuery) onSelect(first.item);
        return;
      }
      if (activeItem?.kind === 'item') onSelect(activeItem.item);
    } else if (e.key === 'Escape' && onEscape) {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    } else if (e.key !== 'Escape' && e.key !== 'Tab') {
      // Typing stays in the field: a host menu (Radix) must not treat it as typeahead.
      e.stopPropagation();
    }
  };

  const renderRow = (i: number, row: PickerRow<T>): ReactNode => {
    if (row.kind === 'header') {
      return (
        <div role="presentation" data-row={i} className="flex items-end px-2 pb-1 text-micro font-semibold text-muted" style={{ height: i === 0 ? 24 : 28 }}>
          {row.label}
        </div>
      );
    }
    const on = row.nav >= 0 && row.nav === active;
    const disabled = row.nav < 0;
    return (
      <div
        id={optionId(row.key)}
        role="option"
        data-row={i}
        data-testid="picker-option"
        aria-selected={on}
        aria-disabled={disabled || undefined}
        onMouseMove={() => !disabled && !on && setAct({ q: query, i: row.nav })}
        // Keep the focus in the field (the listbox is not a tab stop).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => !disabled && onSelect(row.item)}
        className={cx(
          'flex cursor-default items-center gap-2 rounded-[var(--radius-row)] px-2 text-body',
          on ? 'bg-accent-strong text-accent-fg' : 'text-fg',
        )}
        style={{ height: rowPx }}
      >
        {renderItem(row.item, on)}
      </div>
    );
  };

  const empty = rows.length === 0;
  const status = loading && empty ? <Spinner /> : error && empty ? error : empty ? (emptyText ?? t('picker.empty')) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5" data-testid={testId}>
      <div className="relative shrink-0">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
        <input
          ref={input}
          type="search"
          autoFocus={autoFocus && autoFocusAllowed()}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          maxLength={64}
          role="combobox"
          aria-expanded
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={activeItem ? optionId(activeItem.key) : undefined}
          aria-label={placeholder}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="selectable h-8 w-full min-w-0 rounded-[var(--radius-control)] border border-line bg-elev pl-8 pr-2 text-body text-fg placeholder:text-faint focus-visible:outline-offset-0 mobile:h-10 mobile:text-[16px] [&::-webkit-search-cancel-button]:hidden"
        />
      </div>
      <div
        ref={list}
        id={listId}
        role="listbox"
        aria-label={label}
        aria-busy={loading || undefined}
        className={cx('min-h-0', fill && 'flex-1', !virtual && 'overflow-y-auto overscroll-contain')}
        style={fill ? (virtual ? { flexBasis: height } : undefined) : virtual ? { height } : { maxHeight: height }}
      >
        {status !== null ? (
          <div role="presentation" className="grid place-items-center px-3 py-6 text-center text-body text-muted" data-testid="picker-empty">
            {status}
          </div>
        ) : virtual ? (
          <Virtuoso
            ref={virtuoso}
            style={{ height: '100%' }}
            data={rows}
            computeItemKey={(_, r) => r.key}
            itemContent={(i, r) => renderRow(i, r)}
            increaseViewportBy={rowPx * 4}
          />
        ) : (
          rows.map((r, i) => (
            <div key={r.key} className="contents">
              {renderRow(i, r)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * The picker as a popover under its trigger (Radix Popover). On the phone layout every
 * `mat-popover` becomes a bottom sheet (app/styles.css), so this one does too.
 */
export function PickerPopover<T extends PickerItem>({
  children,
  open,
  onOpenChange,
  width = 320,
  align = 'start',
  side = 'bottom',
  ...panel
}: PickerPanelProps<T> & {
  /** The trigger (Radix `asChild`). */
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  width?: number;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
}): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          aria-label={panel.label}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (autoFocusAllowed()) input.current?.focus();
          }}
          className="mat-popover anim-in z-[var(--z-modal-popover)] flex flex-col rounded-[var(--radius-card)] p-1.5"
          // Never past the window edge: the list gives up rows when there is less room (960×600).
          style={{ width, maxHeight: 'var(--radix-popover-content-available-height)' }}
        >
          <PickerPanel {...panel} inputRef={input} autoFocus={false} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
