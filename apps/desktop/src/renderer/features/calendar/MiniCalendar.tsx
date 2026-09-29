import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { WorkspaceRole } from '@calaba/protocol';
import { Tip, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { busyDays } from '../../lib/calendar/events';
import { addDays, addMonths, dayEnd, dayKey, dayStart, formatLongDay, formatMonth, monthGrid, monthOf, weekStart, weekdayNames } from '../../lib/calendar/time';
import { ensureMonth } from '../../services/calendar';
import { useCalendar } from '../../stores/calendar';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';
import { clockFor } from '../shell/voiceFormat';
import { useDayDrag } from './dragState';

/** Today's key, re-rendering only when the date changes (the minute ticker, compared as a string). */
export function useToday(): string {
  const tk = clockFor(60_000);
  return useSyncExternalStore(tk.subscribe, () => dayKey(Date.now()));
}

/**
 * Calendar icon in the room column header (ADR-0038 §7): the number of my upcoming meetings of
 * today (hidden at 0); a click opens the mini month under the header. Not for guests.
 */
export function CalendarButton({ workspaceId }: { workspaceId: string }): ReactNode {
  const count = useCalendar((s) => s.todayCount);
  const open = useUi((s) => s.miniCal);
  const toggle = useUi((s) => s.toggleMiniCal);
  const guest = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.GUEST);
  if (guest) return null;
  const label = count > 0 ? plural('cal.todayCount', count) : t('cal.open');
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls="mini-calendar"
        data-testid="calendar-button"
        onClick={() => toggle()}
        className={cx(
          'relative grid size-8 shrink-0 place-items-center rounded-[var(--radius-icon)] transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg',
          open ? 'bg-active text-fg' : 'text-muted',
        )}
      >
        <CalendarDays className="size-[18px]" aria-hidden />
        {count > 0 ? (
          <span
            aria-hidden
            data-testid="calendar-count"
            className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent-strong px-1 text-micro font-semibold tabular-nums leading-none text-accent-fg"
          >
            {count > 9 ? '9+' : count}
          </span>
        ) : null}
      </button>
    </Tip>
  );
}

/**
 * The mini month under the column header (Apple Calendar): dots on days with meetings, today
 * filled, the selected day raised; ‹ › and «Сегодня»; arrows move the focus (←/→ a day, ↑/↓ a
 * week, PageUp/PageDown a month), Enter opens the day view. A day is also a drop target of the day
 * view's drag (`data-cal-day`: the meeting moves to that day).
 */
export const MiniCalendar = memo(function MiniCalendar({ workspaceId }: { workspaceId: string }): ReactNode {
  const locale = useLocale();
  const today = useToday();
  const selected = useUi((s) => s.calDay);
  const shown = useUi((s) => s.calMonth) ?? monthOf(selected ?? today);
  const setMonth = useUi((s) => s.setCalMonth);
  const first = weekStart(locale);
  const grid = useMemo(() => monthGrid(shown, first), [shown, first]);
  const from = dayStart(grid[0] ?? `${shown}-01`);
  const to = dayEnd(grid[41] ?? `${shown}-28`);
  const busy = useCalendar(useShallow((s) => busyDays(s.occ, workspaceId, from, to)));
  const busySet = useMemo(() => new Set(busy), [busy]);
  const names = useMemo(() => weekdayNames(first), [first, locale]); // eslint-disable-line react-hooks/exhaustive-deps
  const [focusDay, setFocus] = useState<string>(selected ?? today);
  // The focusable day follows the shown month.
  const focus = monthOf(focusDay) === shown ? focusDay : selected && monthOf(selected) === shown ? selected : shown === monthOf(today) ? today : `${shown}-01`;
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => ensureMonth(workspaceId, shown), [workspaceId, shown]);

  const pick = useCallback((day: string) => {
    setFocus(day);
    useUi.getState().openCalendarDay(day, null);
  }, []);

  const move = (day: string): void => {
    setFocus(day);
    if (monthOf(day) !== shown) setMonth(monthOf(day));
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-cal-day="${day}"]`)?.focus());
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) {
      e.preventDefault();
      move(addDays(focus, step[e.key] ?? 0));
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const m = addMonths(monthOf(focus), e.key === 'PageUp' ? -1 : 1);
      const d = Math.min(Number(focus.slice(8)), 28);
      move(`${m}-${String(d).padStart(2, '0')}`);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(today);
    }
  };

  return (
    <section id="mini-calendar" aria-label={t('cal.mini')} className="shrink-0 border-b border-line px-2 pb-2 pt-1.5" data-testid="mini-calendar">
      <div className="flex h-8 items-center gap-1 pl-1.5">
        <h2 className="min-w-0 flex-1 truncate text-control font-semibold" aria-live="polite">
          {formatMonth(shown)}
        </h2>
        <button
          type="button"
          onClick={() => {
            setMonth(monthOf(today));
            pick(today);
          }}
          className="h-6 rounded-full px-2 text-caption font-medium text-fg transition-colors duration-[var(--motion-fast)] hover:bg-hover"
        >
          {t('cal.today')}
        </button>
        <NavArrow label={t('cal.prevMonth')} onClick={() => setMonth(addMonths(shown, -1))} dir={-1} />
        <NavArrow label={t('cal.nextMonth')} onClick={() => setMonth(addMonths(shown, 1))} dir={1} />
      </div>
      <div ref={gridRef} role="grid" aria-label={formatMonth(shown)} onKeyDown={onKey} className="mt-0.5 select-none">
        <div role="row" className="grid grid-cols-7">
          {names.map((n, i) => (
            <span key={i} role="columnheader" className="grid h-5 place-items-center text-micro font-medium text-faint">
              {n}
            </span>
          ))}
        </div>
        {[0, 1, 2, 3, 4, 5].map((w) => (
          <div key={w} role="row" className="grid grid-cols-7">
            {grid.slice(w * 7, w * 7 + 7).map((d) => (
              <DayCell key={d} day={d} inMonth={monthOf(d) === shown} today={d === today} selected={d === selected} busy={busySet.has(d)} focusable={d === focus} onPick={pick} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
});

function NavArrow({ label, onClick, dir }: { label: string; onClick: () => void; dir: -1 | 1 }): ReactNode {
  const Icon = dir < 0 ? ChevronLeft : ChevronRight;
  return (
    <Tip label={label}>
      <button type="button" aria-label={label} onClick={onClick} className="grid size-6 place-items-center rounded-full text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg">
        <Icon className="size-4" aria-hidden />
      </button>
    </Tip>
  );
}

const DayCell = memo(function DayCell({
  day,
  inMonth,
  today,
  selected,
  busy,
  focusable,
  onPick,
}: {
  day: string;
  inMonth: boolean;
  today: boolean;
  selected: boolean;
  busy: boolean;
  focusable: boolean;
  onPick: (day: string) => void;
}): ReactNode {
  // The day view's drag hovering this day (a boolean per cell: the others don't re-render).
  const dropping = useDayDrag((s) => s.overDay === day && !s.locked);
  const label = `${formatLongDay(dayStart(day))}${busy ? `, ${t('cal.hasEvents')}` : ''}`;
  return (
    <div role="gridcell" aria-selected={selected} className="grid h-7 place-items-center">
      <button
        type="button"
        data-cal-day={day}
        tabIndex={focusable ? 0 : -1}
        aria-label={label}
        aria-current={today ? 'date' : undefined}
        onClick={() => onPick(day)}
        className={cx(
          'relative grid size-7 place-items-center rounded-full text-caption tabular-nums transition-colors duration-[var(--motion-fast)]',
          today
            ? 'bg-accent-strong font-semibold text-accent-fg'
            : selected
              ? 'bg-[var(--color-fill-hover)] font-semibold text-fg'
              : inMonth
                ? 'text-fg hover:bg-hover'
                : 'text-faint hover:bg-hover',
          dropping && 'outline outline-2 outline-accent',
        )}
      >
        {Number(day.slice(8))}
        {busy ? <span aria-hidden className={cx('absolute bottom-0.5 size-1 rounded-full', today ? 'bg-accent-fg' : 'bg-[var(--color-label-secondary)]')} /> : null}
      </button>
    </div>
  );
});
