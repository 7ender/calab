import * as ContextMenu from '@radix-ui/react-context-menu';
import { AttendeeStatus, EventRepeat } from '@calaba/protocol';
import { ChevronLeft, ChevronRight, Link2, Pencil, Plus, Copy, Repeat, Trash2, Video, X } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Button, IconButton, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { CLICK_DURATION, DRAG_THRESHOLD_PX, createRange, minutesAt, moveRange, resizeRange, type Range } from '../../lib/calendar/drag';
import { dayKeys, daySignature, myStatusOf, parseSignature } from '../../lib/calendar/events';
import { layoutDay } from '../../lib/calendar/layout';
import { addDays, atMinutes, dayEnd, dayKey, dayStart, eventSpan, formatLongDay, formatMinutes, formatRange, formatTime, monthOf } from '../../lib/calendar/time';
import { useMobile } from '../../lib/mobile';
import { calendarAvailable, canEditEvent, copyEventLink, ensureMonth, eventOf, moveOccurrence } from '../../services/calendar';
import { useCalendar } from '../../stores/calendar';
import { useRooms } from '../../stores/rooms';
import { myUserId } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { NavButton } from '../shell/MobileShell';
import { useNow } from '../shell/voiceFormat';
import { cancelWithConfirm, duplicateEvent, editEvent, newEvent } from './actions';
import { useDayDrag } from './dragState';
import { useToday } from './MiniCalendar';

/** One hour of the grid (px): 24 h = 1152 px, like Apple Calendar's default zoom. */
export const HOUR_PX = 48;
const PX_PER_MIN = HOUR_PX / 60;
/** The time scale left of the grid. */
const GUTTER = 'w-14';
/** Hold near the grid's left / right edge this long while dragging → previous / next day. */
const EDGE_DWELL_MS = 700;
const EDGE_PX = 24;

/**
 * Day view (ADR-0038 §7, Apple Calendar): the day in the centre pane instead of the room — hour
 * grid 00–24, the red «now» line (a leaf, one render a minute), meeting blocks side by side when
 * they overlap, all-day meetings on top, «+ Встреча», ‹ › and «Сегодня». Drag (owner, 29.09):
 * a block moves (15-minute steps), its bottom edge resizes it, onto the all-day row it becomes
 * all-day, onto a day of the mini calendar it moves there (←/→ or holding at the grid's edge
 * switches the day while dragging); a press-and-drag on the empty grid selects a range for a new
 * meeting, a click proposes 30 minutes. Keys: N new, ←/→ day, T today, Delete cancels.
 * The drag lives in a leaf store (dragState.ts); the calendar store is written once, on drop.
 */
export function DayView({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  const today = useToday();
  const day = useUi((s) => s.calDay) ?? today;
  const selected = useUi((s) => s.calEvent);
  const mobile = useMobile();
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const creatable = calendarAvailable(workspaceId);

  useEffect(() => ensureMonth(workspaceId, monthOf(day)), [workspaceId, day]);

  // The day's meetings as one primitive signature: re-render on a change of the set or of a time,
  // not on an answer / title (the blocks subscribe to those themselves).
  const sig = useCalendar((s) => daySignature(s.occ, dayKeys(s.occ, workspaceId, day)));
  const items = useMemo(() => parseSignature(sig), [sig]);
  const timed = useMemo(() => items.filter((i) => !i.allDay), [items]);
  const allDay = useMemo(() => items.filter((i) => i.allDay).map((i) => i.key), [items]);
  const placed = useMemo(() => layoutDay(timed, dayStart(day), dayEnd(day)), [timed, day]);

  // Open at «now» (today) or the selected meeting, else at 08:00 / the first meeting.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const sel = selected ? placed.find((p) => p.key === selected) : undefined;
    const first = placed[0];
    const minute = sel ? sel.top : day === today ? (Date.now() - dayStart(day)) / 60_000 : first ? Math.min(first.top, 8 * 60) : 8 * 60;
    el.scrollTop = Math.max(0, minute * PX_PER_MIN - el.clientHeight / 3);
    // Only when the day changes (not on every list refresh).
  }, [day]); // eslint-disable-line react-hooks/exhaustive-deps

  // A newly selected meeting (created, opened by a link) comes into view.
  useEffect(() => {
    if (!selected) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-occ="${CSS.escape(selected)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const drag = useDragController({ workspaceId, day, grid, scroller, creatable, mobile });

  useDayKeys(workspaceId, day, creatable);

  return (
    <section className="mat-content relative flex min-w-0 flex-1 flex-col" aria-label={t('cal.dayView')} data-testid="day-view">
      <DayHeader workspaceId={workspaceId} day={day} today={today} creatable={creatable} mobile={mobile} />
      <AllDayRow keys={allDay} day={day} onDown={drag.onBlockDown} />
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden" data-testid="day-scroller">
        <div className="relative flex" style={{ height: 24 * HOUR_PX + 16 }}>
          <HourScale />
          <div
            ref={grid}
            className="relative mr-2 mt-2 flex-1 touch-pan-y"
            style={{ height: 24 * HOUR_PX }}
            onPointerDown={drag.onGridDown}
            data-testid="day-grid"
          >
            <HourLines />
            {placed.map((p) => (
              <EventBlock key={p.key} occKey={p.key} top={p.top} height={p.height} col={p.col} cols={p.cols} onDown={drag.onBlockDown} />
            ))}
            {day === today ? <NowLine day={day} /> : null}
            <DragGhost />
          </div>
        </div>
      </div>
      {items.length === 0 && creatable ? (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 px-6 text-center text-body text-muted" data-testid="day-empty">
          {t('cal.emptyHint')}
        </p>
      ) : null}
      <DropCursor />
    </section>
  );
}

/** While a locked meeting is dragged: the «not allowed» cursor over everything. */
function DropCursor(): ReactNode {
  const locked = useDayDrag((s) => s.locked);
  return locked ? <div className="fixed inset-0 z-[var(--z-popover)] cursor-not-allowed" aria-hidden /> : null;
}

function DayHeader({ workspaceId, day, today, creatable, mobile }: { workspaceId: string; day: string; today: string; creatable: boolean; mobile: boolean }): ReactNode {
  const open = useUi((s) => s.openCalendarDay);
  const close = useUi((s) => s.closeCalendar);
  const title = formatLongDay(dayStart(day));
  const touch = mobile ? 'size-10 rounded-full' : undefined;
  return (
    <header className={cx('mat-toolbar flex h-12 shrink-0 items-center gap-1 border-b border-line pl-3 pr-2', mobile && 'pl-1')}>
      {mobile ? <NavButton /> : null}
      <IconButton label={t('cal.prevDay')} shortcut="←" onClick={() => open(addDays(day, -1))} className={touch}>
        <ChevronLeft className="size-[18px]" />
      </IconButton>
      <IconButton label={t('cal.nextDay')} shortcut="→" onClick={() => open(addDays(day, 1))} className={touch}>
        <ChevronRight className="size-[18px]" />
      </IconButton>
      <h1 className="ml-1 min-w-0 flex-1 truncate text-list font-semibold first-letter:uppercase" aria-live="polite">
        {title}
      </h1>
      {day !== today ? (
        <Button variant="secondary" size="sm" onClick={() => open(today)} title="T">
          {t('cal.today')}
        </Button>
      ) : null}
      {creatable ? (
        <Button size="sm" onClick={() => newEvent(workspaceId, defaultDraft(day))} data-testid="day-new-event" title="N">
          <Plus className="size-3.5" aria-hidden />
          {t('cal.newEvent')}
        </Button>
      ) : null}
      <IconButton label={t('cal.close')} onClick={close} className={touch}>
        <X className="size-[18px]" />
      </IconButton>
    </header>
  );
}

/** «+ Встреча» on a day: the next full half hour today, 10:00 on another day; 30 minutes. */
function defaultDraft(day: string): { start: number; end: number } {
  const now = new Date();
  let start = atMinutes(day, 10 * 60).getTime();
  if (dayKey(now) === day) {
    const m = Math.min(23 * 60, Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30);
    start = atMinutes(day, m).getTime();
  }
  return { start, end: start + CLICK_DURATION * 60_000 };
}

const HourScale = memo(function HourScale(): ReactNode {
  useLocale();
  return (
    <div className={cx(GUTTER, 'relative mt-2 shrink-0 select-none')} aria-hidden style={{ height: 24 * HOUR_PX }}>
      {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
        <span key={h} className="absolute right-2 -translate-y-1/2 text-micro tabular-nums text-faint" style={{ top: h * HOUR_PX }}>
          {formatMinutes(h * 60)}
        </span>
      ))}
    </div>
  );
});

const HourLines = memo(function HourLines(): ReactNode {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {Array.from({ length: 24 }, (_, h) => (
        <div key={h} className="absolute inset-x-0 border-t border-line" style={{ top: h * HOUR_PX }} />
      ))}
      <div className="absolute inset-x-0 border-t border-line" style={{ top: 24 * HOUR_PX }} />
    </div>
  );
});

/** The red «now» line (Apple): its own minute ticker — the only thing re-rendered by time. */
const NowLine = memo(function NowLine({ day }: { day: string }): ReactNode {
  const now = useNow(60_000);
  if (dayKey(now) !== day) return null;
  const min = (now - dayStart(day)) / 60_000;
  return (
    <div className="pointer-events-none absolute inset-x-0 z-[2]" style={{ top: min * PX_PER_MIN }} data-testid="now-line" aria-label={t('cal.now', { time: formatTime(now) })} role="img">
      <span className="absolute -left-[5px] -top-[5px] size-2.5 rounded-full bg-danger" />
      <div className="h-0.5 -translate-y-1/2 bg-danger" />
    </div>
  );
});

// ---------------------------------------------------------------- blocks

type BlockDown = (e: ReactPointerEvent<HTMLElement>, key: string, mode: 'move' | 'resize') => void;

/** How a block looks: my answer tints it (declined — faded, no answer yet — dashed), selected — filled. */
function blockTone(status: AttendeeStatus, selected: boolean): string {
  if (selected) return 'bg-accent-strong text-accent-fg border-accent-strong';
  if (status === AttendeeStatus.DECLINED) return 'bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-muted border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)]';
  if (status === AttendeeStatus.PENDING) return 'bg-[color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg))] text-fg border-accent border-dashed';
  return 'bg-[color-mix(in_srgb,var(--color-accent)_24%,var(--color-bg))] text-fg border-accent';
}

const EventBlock = memo(function EventBlock({
  occKey,
  top,
  height,
  col,
  cols,
  onDown,
}: {
  occKey: string;
  top: number;
  height: number;
  col: number;
  cols: number;
  onDown: BlockDown;
}): ReactNode {
  const ev = useCalendar((s) => s.occ[occKey]);
  const roomName = useRooms((s) => (ev?.roomId ? (s.byId[ev.roomId]?.name ?? '') : ''));
  const selected = useUi((s) => s.calEvent === occKey);
  const lifted = useDayDrag((s) => s.key === occKey && !s.locked && (s.mode === 'move' || s.mode === 'resize'));
  if (!ev) return null;
  const editable = canEditEvent(ev);
  const status = myStatusOf(ev, myUserId());
  const time = formatRange(ev);
  const label = roomName ? t('cal.blockRoom', { title: ev.title, time, room: roomName }) : t('cal.block', { title: ev.title, time });
  const px = height * PX_PER_MIN;
  const short = px < 38;
  return (
    <BlockMenu occKey={occKey} editable={editable}>
      <div
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-pressed={selected}
        data-occ={occKey}
        data-testid="event-block"
        title={editable ? undefined : t('cal.locked')}
        onPointerDown={(e) => onDown(e, occKey, 'move')}
        onDoubleClick={() => editable && editEvent(occKey)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            useUi.getState().selectCalEvent(occKey);
          }
        }}
        className={cx(
          'absolute z-[1] overflow-hidden rounded-[6px] border-l-[3px] px-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent',
          short ? 'py-0' : 'py-1',
          blockTone(status, selected),
          lifted && 'opacity-40',
        )}
        style={{
          top: top * PX_PER_MIN + 1,
          height: Math.max(18, px - 2),
          left: `calc(${(col / cols) * 100}% + 2px)`,
          width: `calc(${100 / cols}% - 4px)`,
        }}
      >
        {short ? (
          <p className="truncate text-caption leading-4">
            <span className="font-semibold">{ev.title}</span>
            <span className="opacity-80"> · {formatTime(eventSpan(ev).start)}</span>
          </p>
        ) : (
          <>
            <p className={cx('truncate text-caption font-semibold', status === AttendeeStatus.DECLINED && !selected && 'line-through')}>{ev.title}</p>
            <p className="truncate text-caption opacity-80">
              {time}
              {roomName ? ` · ${roomName}` : ''}
            </p>
            {px > 70 && ev.repeat !== EventRepeat.UNSPECIFIED ? <Repeat className="mt-0.5 size-3 opacity-70" aria-hidden /> : null}
          </>
        )}
        {editable ? (
          <span
            aria-hidden
            data-testid="event-resize"
            onPointerDown={(e) => {
              e.stopPropagation();
              onDown(e, occKey, 'resize');
            }}
            className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
          />
        ) : null}
      </div>
    </BlockMenu>
  );
});

/** Right click on a block: every action of the card (owner addendum). */
function BlockMenu({ occKey, editable, children }: { occKey: string; editable: boolean; children: ReactNode }): ReactNode {
  const ev = useCalendar((s) => s.occ[occKey]);
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={cx(menuBox, 'w-56')}>
          {editable ? (
            <ContextMenu.Item className={menuItem} onSelect={() => editEvent(occKey)}>
              <Pencil className="size-4" aria-hidden /> {t('cal.edit')}
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Item className={menuItem} onSelect={() => duplicateEvent(occKey)}>
            <Copy className="size-4" aria-hidden /> {t('cal.duplicate')}
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => ev && copyEventLink(ev.id)}>
            <Link2 className="size-4" aria-hidden /> {t('cal.copyLink')}
          </ContextMenu.Item>
          {ev?.roomId ? (
            <ContextMenu.Item className={menuItem} onSelect={() => useUi.getState().openRoom(ev.workspaceId, ev.roomId)}>
              <Video className="size-4" aria-hidden /> {t('cal.go')}
            </ContextMenu.Item>
          ) : null}
          {editable ? (
            <>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void cancelWithConfirm(occKey)}>
                <Trash2 className="size-4" aria-hidden /> {ev && ev.repeat !== EventRepeat.UNSPECIFIED ? t('cal.cancelOne') : t('cal.cancel')}
              </ContextMenu.Item>
            </>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** All-day meetings above the grid; a drop target that makes a dragged meeting all-day. */
function AllDayRow({ keys, day, onDown }: { keys: readonly string[]; day: string; onDown: BlockDown }): ReactNode {
  // Always there (Apple Calendar): a stable grid under a drag, and a visible drop target.
  const dropping = useDayDrag((s) => s.allDay && !s.locked && s.mode === 'move');
  return (
    <div
      data-cal-allday={day}
      className={cx('flex shrink-0 items-start gap-0 border-b border-line py-1 pr-2', dropping && 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]')}
      data-testid="allday-row"
    >
      <span className={cx(GUTTER, 'shrink-0 pr-2 pt-0.5 text-right text-micro text-faint')}>{t('cal.allDayRow')}</span>
      <div className="flex min-h-6 min-w-0 flex-1 flex-col gap-0.5">
        {keys.map((k) => (
          <AllDayChip key={k} occKey={k} onDown={onDown} />
        ))}
      </div>
    </div>
  );
}

const AllDayChip = memo(function AllDayChip({ occKey, onDown }: { occKey: string; onDown: BlockDown }): ReactNode {
  const ev = useCalendar((s) => s.occ[occKey]);
  const selected = useUi((s) => s.calEvent === occKey);
  if (!ev) return null;
  const editable = canEditEvent(ev);
  return (
    <BlockMenu occKey={occKey} editable={editable}>
      <div
        role="button"
        tabIndex={0}
        data-occ={occKey}
        data-testid="event-block"
        aria-pressed={selected}
        aria-label={t('cal.block', { title: ev.title, time: formatRange(ev) })}
        title={editable ? undefined : t('cal.locked')}
        onPointerDown={(e) => onDown(e, occKey, 'move')}
        onDoubleClick={() => editable && editEvent(occKey)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            useUi.getState().selectCalEvent(occKey);
          }
        }}
        className={cx('truncate rounded-[6px] border-l-[3px] px-1.5 text-caption font-semibold leading-5 outline-none focus-visible:ring-2 focus-visible:ring-accent', blockTone(myStatusOf(ev, myUserId()), selected))}
      >
        {ev.title}
      </div>
    </BlockMenu>
  );
});

/** The dragged block's (or the selected range's) outline with its time — the only thing that follows the pointer. */
const DragGhost = memo(function DragGhost(): ReactNode {
  const range = useDayDrag((s) => (s.locked ? null : s.range));
  const mode = useDayDrag((s) => s.mode);
  if (!range || !mode) return null;
  const top = range.start * PX_PER_MIN;
  const h = (range.end - range.start) * PX_PER_MIN;
  const text = `${formatMinutes(range.start)} – ${formatMinutes(range.end % 1440 === 0 && range.end > 0 ? 0 : range.end)}`;
  return (
    <div
      className="pointer-events-none absolute inset-x-0.5 z-[3] rounded-[6px] border-2 border-dashed border-accent bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)]"
      style={{ top, height: Math.max(12, h) }}
      data-testid="drag-ghost"
    >
      <span className="absolute left-1.5 top-0.5 rounded bg-accent-strong px-1 text-micro font-semibold tabular-nums text-accent-fg">{text}</span>
    </div>
  );
});

// ---------------------------------------------------------------- drag controller

interface Press {
  kind: 'block' | 'grid';
  key: string | null;
  mode: 'move' | 'resize' | 'create';
  editable: boolean;
  touch: boolean;
  x0: number;
  y0: number;
  moved: boolean;
  /** The block's range in minutes of the day where the press started. */
  orig: Range;
  wasAllDay: boolean;
  /** Minutes between the block's top and the press point. */
  grab: number;
  /** Grid minute under the press (a range selection). */
  anchor: number;
  /** Last pointer (edge dwell, key-switched days re-evaluate it). */
  x: number;
  y: number;
}

function useDragController({
  workspaceId,
  day,
  grid,
  scroller,
  creatable,
  mobile,
}: {
  workspaceId: string;
  day: string;
  grid: React.RefObject<HTMLDivElement | null>;
  scroller: React.RefObject<HTMLDivElement | null>;
  creatable: boolean;
  mobile: boolean;
}): { onGridDown: (e: ReactPointerEvent<HTMLDivElement>) => void; onBlockDown: BlockDown } {
  const press = useRef<Press | null>(null);
  const dayRef = useRef(day);
  useEffect(() => {
    dayRef.current = day;
  }, [day]);
  const edgeTimer = useRef<number | null>(null);
  const edgeSide = useRef<-1 | 0 | 1>(0);

  const minuteAt = (clientY: number): number => {
    const r = grid.current?.getBoundingClientRect();
    return r ? minutesAt(clientY - r.top, PX_PER_MIN) : 0;
  };

  const update = useCallback((x: number, y: number): void => {
    const p = press.current;
    if (!p || !p.moved) return;
    const drag = useDayDrag.getState();
    if (p.mode === 'create') {
      drag.set({ range: createRange(p.anchor, minuteAt(y), true) });
      return;
    }
    if (p.mode === 'resize') {
      drag.set({ range: resizeRange(p.orig, minuteAt(y)) });
      return;
    }
    const under = document.elementFromPoint(x, y);
    const overDay = under?.closest<HTMLElement>('[data-cal-day]')?.dataset['calDay'] ?? null;
    if (overDay) {
      drag.set({ overDay, allDay: false, range: null });
      return;
    }
    if (under?.closest('[data-cal-allday]')) {
      drag.set({ allDay: true, overDay: null, range: null });
      return;
    }
    const g = grid.current?.getBoundingClientRect();
    const inGrid = !!g && x >= g.left - 60 && x <= g.right + 8;
    drag.set({ allDay: false, overDay: null, range: inGrid ? moveRange(p.orig, p.grab, minuteAt(y)) : null });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stopEdge = (): void => {
    if (edgeTimer.current !== null) window.clearTimeout(edgeTimer.current);
    edgeTimer.current = null;
    edgeSide.current = 0;
  };

  // Holding at the grid's left / right edge while moving a block flips the day (repeats).
  const edge = (x: number): void => {
    const p = press.current;
    const box = scroller.current?.getBoundingClientRect();
    if (!p || p.mode !== 'move' || !p.editable || !box) {
      stopEdge();
      return;
    }
    const side: -1 | 0 | 1 = x < box.left + EDGE_PX ? -1 : x > box.right - EDGE_PX ? 1 : 0;
    if (side === edgeSide.current) return;
    stopEdge();
    edgeSide.current = side;
    if (!side) return;
    const flip = (): void => {
      useUi.getState().openCalendarDay(addDays(dayRef.current, side));
      edgeTimer.current = window.setTimeout(flip, EDGE_DWELL_MS);
    };
    edgeTimer.current = window.setTimeout(flip, EDGE_DWELL_MS);
  };

  // A day switched while dragging (←/→, edge): the ghost re-evaluates at the same pointer.
  useEffect(() => {
    const p = press.current;
    if (p?.moved) requestAnimationFrame(() => update(p.x, p.y));
  }, [day, update]);

  const onMove = useCallback((e: PointerEvent): void => {
    const p = press.current;
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (!p.moved) {
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < DRAG_THRESHOLD_PX) return;
      // Touch: a drag is a scroll (no long-press drag on phones — the card has the same actions).
      if (p.touch) {
        press.current = null;
        detach();
        return;
      }
      p.moved = true;
      if (p.kind === 'block' && !p.editable) {
        useDayDrag.getState().set({ key: p.key, mode: p.mode, locked: true });
        return;
      }
      useDayDrag.getState().set({ key: p.key, mode: p.mode, locked: false });
    }
    if (useDayDrag.getState().locked) return;
    // Near the scroller's top / bottom: scroll the grid.
    const box = scroller.current?.getBoundingClientRect();
    if (box && scroller.current) {
      if (e.clientY < box.top + 24) scroller.current.scrollTop -= 12;
      else if (e.clientY > box.bottom - 24) scroller.current.scrollTop += 12;
    }
    update(e.clientX, e.clientY);
    edge(e.clientX);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onUp = useCallback((e: PointerEvent): void => {
    const p = press.current;
    press.current = null;
    detach();
    stopEdge();
    const drag = useDayDrag.getState();
    const { range, allDay, overDay, locked } = drag;
    drag.clear();
    if (!p || e.type === 'pointercancel') return;
    const viewDay = dayRef.current;
    if (!p.moved) {
      if (p.kind === 'block' && p.key) useUi.getState().selectCalEvent(p.key);
      else if (p.kind === 'grid' && creatable) {
        const r = createRange(p.anchor, p.anchor, false);
        newEvent(workspaceId, { start: atMinutes(viewDay, r.start).getTime(), end: atMinutes(viewDay, r.end).getTime() });
      }
      return;
    }
    if (locked) return;
    if (p.mode === 'create') {
      if (range) newEvent(workspaceId, { start: atMinutes(viewDay, range.start).getTime(), end: atMinutes(viewDay, range.end).getTime() });
      return;
    }
    if (!p.key) return;
    const ev = eventOf(p.key);
    if (!ev) return;
    const span = eventSpan(ev);
    let start: number;
    let end: number;
    let nextAllDay = ev.allDay;
    if (overDay) {
      if (ev.allDay) {
        start = dayStart(overDay);
        end = dayStart(addDays(overDay, Math.max(1, Math.round((span.end - span.start) / 86_400_000))));
      } else {
        start = atMinutes(overDay, Math.max(0, p.orig.start)).getTime();
        end = start + (span.end - span.start);
      }
    } else if (allDay) {
      nextAllDay = true;
      start = dayStart(viewDay);
      end = dayEnd(viewDay);
    } else if (range) {
      nextAllDay = false;
      start = atMinutes(viewDay, range.start).getTime();
      end = atMinutes(viewDay, range.end).getTime();
    } else return;
    if (start === span.start && end === span.end && nextAllDay === ev.allDay) return;
    void moveOccurrence(p.key, start, end, nextAllDay !== ev.allDay ? nextAllDay : undefined);
  }, [creatable, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  function detach(): void {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  }

  const attach = (): void => {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  useEffect(() => () => {
    detach();
    stopEdge();
    useDayDrag.getState().clear();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onBlockDown: BlockDown = (e, key, mode) => {
    if (e.button !== 0 || press.current) return;
    e.stopPropagation();
    const ev = eventOf(key);
    if (!ev) return;
    const ds = dayStart(dayRef.current);
    const span = eventSpan(ev);
    const orig = ev.allDay ? { start: 9 * 60, end: 10 * 60 } : { start: (span.start - ds) / 60_000, end: (span.end - ds) / 60_000 };
    const grab = ev.allDay ? 0 : minuteAt(e.clientY) - orig.start;
    press.current = {
      kind: 'block',
      key,
      mode,
      editable: canEditEvent(ev),
      touch: e.pointerType === 'touch' || mobile,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      orig,
      wasAllDay: ev.allDay,
      grab,
      anchor: 0,
    };
    attach();
  };

  const onGridDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || press.current || e.target !== e.currentTarget) return;
    press.current = {
      kind: 'grid',
      key: null,
      mode: 'create',
      editable: creatable,
      touch: e.pointerType === 'touch' || mobile,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      orig: { start: 0, end: 0 },
      wasAllDay: false,
      grab: 0,
      anchor: minuteAt(e.clientY),
    };
    if (!creatable) return;
    attach();
  };

  return { onGridDown, onBlockDown };
}

// ---------------------------------------------------------------- keys

/** N new, ←/→ day, T today, Delete cancels the selected meeting (not while typing or in a dialog). */
function useDayKeys(workspaceId: string, day: string, creatable: boolean): void {
  const dayRef = useRef(day);
  useEffect(() => {
    dayRef.current = day;
  }, [day]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const ui = useUi.getState();
      if (ui.dialog) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"], [role="grid"], [role="menu"], [role="dialog"], [role="listbox"]')) return;
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        ui.openCalendarDay(addDays(dayRef.current, k === 'ArrowLeft' ? -1 : 1));
      } else if ((k === 't' || k === 'T' || k === 'е' || k === 'Е') && !e.shiftKey) {
        e.preventDefault();
        ui.openCalendarDay(dayKey(Date.now()));
      } else if ((k === 'n' || k === 'N' || k === 'т' || k === 'Т') && creatable) {
        e.preventDefault();
        newEvent(workspaceId, defaultDraft(dayRef.current));
      } else if ((k === 'Delete' || k === 'Backspace') && ui.calEvent) {
        e.preventDefault();
        void cancelWithConfirm(ui.calEvent);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspaceId, creatable]);
}

