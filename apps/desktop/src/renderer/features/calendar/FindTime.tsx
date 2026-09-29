import { ChevronLeft, ChevronRight, CalendarSearch, X } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Avatar } from '../../components/Avatar';
import { Button, IconButton, Input, Modal, Segmented, Spinner, Switch, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { freeWindows, subtractIntervals, workIntervals, type Interval } from '../../lib/calendar/freebusy';
import { freebusyApi, noCommonHours } from '../../lib/calendar/freebusyApi';
import { addPeople, personColor } from '../../lib/calendar/people';
import { addDays, dayEnd, dayKey, dayStart, formatLongDay, formatShortDay, formatTime } from '../../lib/calendar/time';
import { useMobile } from '../../lib/mobile';
import { busySignature, ensureBusy, hoursSignature, parseBusySignature, parseHoursSignature } from '../../services/freebusy';
import { entryKey, useFreeBusy } from '../../stores/freebusy';
import { myUserId } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { NavButton } from '../shell/MobileShell';
import { useNow } from '../shell/voiceFormat';
import { newEvent } from './actions';
import { GUTTER, HOUR_PX, HourLines, HourScale, NowLine, PX_PER_MIN } from './gridParts';
import { useToday } from './MiniCalendar';
import { PeopleBar } from './PeopleBar';

/*
 * «Подобрать время» (ADR-0041 §3, Apple Calendar «Доступность»): chips of people, the duration
 * and «в рабочие часы»; a column of busy time per person (their colour; grey outside their work
 * hours; an external calendar's busy time hatched), the common free windows green, «Ближайшие
 * окна» from the server's suggest. A click on a window or a drag over a green area picks the time:
 * the meeting dialog opens prefilled (from the day view) or takes it back (from the dialog).
 * The columns are memo leaves selecting one person's day as a primitive: a voice / presence event
 * re-renders none of them (tools/perf-call.ts).
 */

export const DURATIONS = [30, 45, 60, 90] as const;
const MIN = 60_000;
/** Suggestions look two weeks ahead (the free / busy window). */
const SUGGEST_SPAN = 14 * 86_400_000;

/** The controls' state and its setters — from the store (day view) or local (the dialog). */
export interface FindCtl {
  workspaceId: string;
  users: readonly string[];
  durationMin: number;
  workHours: boolean;
  day: string;
  addUsers: (ids: readonly string[]) => void;
  removeUser: (id: string) => void;
  setDuration: (min: number) => void;
  setWorkHours: (on: boolean) => void;
  setDay: (day: string) => void;
}

// ---------------------------------------------------------------- the day view's mode

/** «Подобрать время» in the centre pane (the store's `find`); ‹ › / ←/→ change the day, Esc / «×» close. */
export function FindTimePane({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  const today = useToday();
  const day = useUi((s) => s.calDay) ?? today;
  const find = useFreeBusy((s) => s.find);
  const mobile = useMobile();
  const [highlight, setHighlight] = useState<Interval | null>(null);
  const ctl = useMemo<FindCtl | null>(() => {
    if (!find) return null;
    const fb = useFreeBusy.getState;
    return {
      workspaceId,
      users: find.users,
      durationMin: find.durationMin,
      workHours: find.workHours,
      day,
      addUsers: (ids) => fb().patchFind({ users: addPeople(fb().find?.users ?? [], ids).list }),
      removeUser: (id) => fb().patchFind({ users: (fb().find?.users ?? []).filter((u) => u !== id) }),
      setDuration: (durationMin) => fb().patchFind({ durationMin }),
      setWorkHours: (workHours) => fb().patchFind({ workHours }),
      setDay: (d) => useUi.getState().openCalendarDay(d),
    };
  }, [find, workspaceId, day]);

  const close = useCallback(() => useFreeBusy.getState().setFind(null), []);
  useFindKeys(day, close);

  if (!ctl) return null;
  const pick = (slot: Interval): void => {
    const me = myUserId();
    useUi.getState().openCalendarDay(dayKey(slot.start));
    newEvent(workspaceId, { start: slot.start, end: slot.end, attendees: ctl.users.filter((u) => u !== me) });
  };
  const touch = mobile ? 'size-10 rounded-full' : undefined;

  return (
    <section className="mat-content relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('fb.find')} data-testid="find-time">
      <header className={cx('mat-toolbar flex h-12 shrink-0 items-center gap-1 border-b border-line pl-3 pr-2', mobile && 'pl-1')}>
        {mobile ? <NavButton /> : null}
        <IconButton label={t('cal.prevDay')} shortcut="←" onClick={() => ctl.setDay(addDays(day, -1))} className={touch}>
          <ChevronLeft className="size-[18px]" />
        </IconButton>
        <IconButton label={t('cal.nextDay')} shortcut="→" onClick={() => ctl.setDay(addDays(day, 1))} className={touch}>
          <ChevronRight className="size-[18px]" />
        </IconButton>
        <h1 className="ml-1 flex min-w-0 flex-1 items-baseline gap-2 truncate text-list font-semibold">
          <span className="shrink-0">{t('fb.find')}</span>
          <span className="truncate font-normal text-muted first-letter:uppercase">{mobile ? formatShortDay(dayStart(day)) : formatLongDay(dayStart(day))}</span>
        </h1>
        {day !== today ? (
          <Button variant="secondary" size={mobile ? 'md' : 'sm'} onClick={() => ctl.setDay(today)}>
            {t('cal.today')}
          </Button>
        ) : null}
        <IconButton label={t('fb.closeFind')} shortcut="Esc" onClick={close} className={touch} data-testid="find-close">
          <X className="size-[18px]" />
        </IconButton>
      </header>
      <FindControls ctl={ctl} wrap={mobile} />
      {mobile ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SlotList ctl={ctl} onPick={pick} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <AvailabilityGrid ctl={ctl} onPick={pick} highlight={highlight} />
          <aside className="flex w-64 shrink-0 flex-col border-l border-line" aria-label={t('fb.slots')}>
            <SlotList ctl={ctl} onPick={pick} onShow={setHighlight} />
          </aside>
        </div>
      )}
    </section>
  );
}

/** ←/→ day, Esc closes (not while typing, not under a dialog or menu). */
function useFindKeys(day: string, close: () => void): void {
  const dayRef = useRef(day);
  useEffect(() => {
    dayRef.current = day;
  }, [day]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || useUi.getState().dialog) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        useUi.getState().openCalendarDay(addDays(dayRef.current, e.key === 'ArrowLeft' ? -1 : 1));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
}

// ---------------------------------------------------------------- the dialog's run

/**
 * «Подобрать время» next to the meeting dialog's times: the same controls on local state,
 * prefilled with me and the attendees; a picked slot goes back to the dialog.
 */
export function FindTimeDialog({
  workspaceId,
  users: initUsers,
  durationMin: initDuration,
  day: initDay,
  onPick,
  onClose,
}: {
  workspaceId: string;
  users: readonly string[];
  durationMin: number;
  day: string;
  onPick: (slot: Interval, users: readonly string[]) => void;
  onClose: () => void;
}): ReactNode {
  const mobile = useMobile();
  const [users, setUsers] = useState<readonly string[]>(initUsers);
  const [durationMin, setDuration] = useState(initDuration);
  const [workHours, setWorkHours] = useState(true);
  const [day, setDay] = useState(initDay);
  const [highlight, setHighlight] = useState<Interval | null>(null);
  const ctl = useMemo<FindCtl>(
    () => ({
      workspaceId,
      users,
      durationMin,
      workHours,
      day,
      addUsers: (ids) => setUsers((u) => addPeople(u, ids).list),
      removeUser: (id) => setUsers((u) => u.filter((x) => x !== id)),
      setDuration,
      setWorkHours,
      setDay,
    }),
    [workspaceId, users, durationMin, workHours, day],
  );
  const pick = (slot: Interval): void => onPick(slot, users);
  return (
    <Modal open onClose={onClose} title={t('fb.find')} wide fill>
      <div className="-mx-5 -mt-4 flex min-h-0 flex-1 flex-col" data-testid="find-time-dialog">
        <FindControls ctl={ctl} wrap />
        {mobile ? (
          <SlotList ctl={ctl} onPick={pick} />
        ) : (
          <>
            <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-3">
              <IconButton label={t('cal.prevDay')} onClick={() => setDay((d) => addDays(d, -1))}>
                <ChevronLeft className="size-[18px]" />
              </IconButton>
              <IconButton label={t('cal.nextDay')} onClick={() => setDay((d) => addDays(d, 1))}>
                <ChevronRight className="size-[18px]" />
              </IconButton>
              <span className="ml-1 truncate text-control font-semibold first-letter:uppercase">{formatLongDay(dayStart(day))}</span>
            </div>
            <div className="flex h-[min(420px,calc(100vh-340px))] min-h-[240px]">
              <AvailabilityGrid ctl={ctl} onPick={pick} highlight={highlight} />
              <aside className="flex w-56 shrink-0 flex-col border-l border-line" aria-label={t('fb.slots')}>
                <SlotList ctl={ctl} onPick={pick} onShow={setHighlight} />
              </aside>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- controls

function FindControls({ ctl, wrap }: { ctl: FindCtl; wrap: boolean }): ReactNode {
  const preset = (DURATIONS as readonly number[]).includes(ctl.durationMin);
  const [custom, setCustom] = useState(!preset);
  const [text, setText] = useState(String(ctl.durationMin));
  const value = custom ? 'custom' : String(ctl.durationMin);
  const commit = (raw: string): void => {
    const n = Math.round(Number(raw) / 15) * 15;
    if (Number.isFinite(n) && n >= 15 && n <= 480) ctl.setDuration(n);
    else setText(String(ctl.durationMin));
  };
  return (
    // Two lines: the people (they may be many) above the duration and «в рабочие часы».
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2" data-testid="find-controls">
      <div className="flex w-full min-w-0 items-center">
        <PeopleBar workspaceId={ctl.workspaceId} people={ctl.users} onAdd={ctl.addUsers} onRemove={ctl.removeUser} wrap={wrap} testId="find-people" />
      </div>
      <div className="flex items-center gap-2">
        <Segmented
          label={t('fb.duration')}
          value={value}
          options={[...DURATIONS.map((m) => ({ value: String(m), label: t('fb.min', { n: m }) })), { value: 'custom', label: t('fb.custom') }]}
          onChange={(v) => {
            if (v === 'custom') {
              setCustom(true);
              setText(String(ctl.durationMin));
              return;
            }
            setCustom(false);
            ctl.setDuration(Number(v));
          }}
        />
        {custom ? (
          <Input
            type="number"
            min={15}
            max={480}
            step={15}
            value={text}
            aria-label={t('fb.customMin')}
            onChange={(e) => setText(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
            className="w-20"
            data-testid="find-custom"
          />
        ) : null}
      </div>
      <Switch label={t('fb.workHours')} checked={ctl.workHours} onChange={ctl.setWorkHours} />
    </div>
  );
}

// ---------------------------------------------------------------- the grid

/** Columns of busy time, one per person, over the hour grid; the common free windows green. */
function AvailabilityGrid({ ctl, onPick, highlight }: { ctl: FindCtl; onPick: (slot: Interval) => void; highlight: Interval | null }): ReactNode {
  const { workspaceId, users, day } = ctl;
  const scroller = useRef<HTMLDivElement>(null);
  const from = dayStart(day);
  const to = dayEnd(day);
  useEffect(() => ensureBusy(workspaceId, users, from, to), [workspaceId, users, from, to]);

  // Open at the earliest work start of the people (their zones), else 08:00; a highlighted slot comes into view.
  const hours = useFreeBusy(useShallow((s) => users.map((u) => hoursSignature(s.entries[entryKey(workspaceId, u)]))));
  const firstWork = useMemo(() => {
    let min = 8 * 60;
    for (const h of hours) {
      const p = parseHoursSignature(h);
      const w = p ? workIntervals(p.workHours, p.timezone, from, to)[0] : undefined;
      if (w) min = Math.min(min, (w.start - from) / MIN);
    }
    return min;
  }, [hours, from, to]);
  const loaded = hours.every(Boolean);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = Math.max(0, (firstWork - 60) * PX_PER_MIN);
    // Once per day (and when the people's hours arrive).
  }, [day, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = scroller.current;
    if (!el || !highlight || highlight.start < from || highlight.start >= to) return;
    const top = ((highlight.start - from) / MIN) * PX_PER_MIN;
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 60) el.scrollTo({ top: Math.max(0, top - el.clientHeight / 3) });
  }, [highlight, from, to]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="availability">
      <div className="flex shrink-0 border-b border-line pr-2">
        <div className={cx(GUTTER, 'shrink-0')} />
        {users.map((u, i) => (
          <ColumnHead key={u} workspaceId={workspaceId} userId={u} color={personColor(i)} />
        ))}
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="relative flex" style={{ height: 24 * HOUR_PX + 16 }}>
          <HourScale />
          <div className="relative mr-2 mt-2 flex flex-1" style={{ height: 24 * HOUR_PX }}>
            <HourLines />
            {users.map((u, i) => (
              <BusyColumn key={u} workspaceId={workspaceId} userId={u} day={day} color={personColor(i)} />
            ))}
            <FreeOverlay ctl={ctl} onPick={onPick} highlight={highlight} />
            <NowLine day={day} />
          </div>
        </div>
      </div>
    </div>
  );
}

const ColumnHead = memo(function ColumnHead({ workspaceId, userId, color }: { workspaceId: string; userId: string; color: string }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const avatar = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]?.user?.avatarFileId ?? '');
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 border-l border-line px-1 py-1.5" title={name}>
      <span className="grid size-6 shrink-0 place-items-center rounded-full" style={{ boxShadow: `inset 0 0 0 2px ${color}` }}>
        <Avatar userId={userId} name={name} {...(avatar ? { fileId: avatar } : {})} size={20} />
      </span>
      <span className="min-w-0 truncate text-caption font-medium">{userId === myUserId() ? t('fb.me') : name}</span>
    </div>
  );
});

/** One person's day: grey outside their work hours, busy blocks in their colour (external: hatched). */
const BusyColumn = memo(function BusyColumn({ workspaceId, userId, day, color }: { workspaceId: string; userId: string; day: string; color: string }): ReactNode {
  const from = dayStart(day);
  const to = dayEnd(day);
  const sig = useFreeBusy((s) => busySignature(s.entries[entryKey(workspaceId, userId)], from, to));
  const hoursSig = useFreeBusy((s) => hoursSignature(s.entries[entryKey(workspaceId, userId)]));
  const name = useMemberName(workspaceId, userId);
  const busy = useMemo(() => parseBusySignature(sig), [sig]);
  const off = useMemo(() => {
    const h = parseHoursSignature(hoursSig);
    return h ? subtractIntervals([{ start: from, end: to }], workIntervals(h.workHours, h.timezone, from, to)) : [];
  }, [hoursSig, from, to]);
  const y = (ms: number): number => ((Math.max(from, Math.min(to, ms)) - from) / MIN) * PX_PER_MIN;
  return (
    <div className="relative min-w-0 flex-1 border-l border-line" data-testid="busy-column" data-user={userId}>
      {off.map((o) => (
        <div key={o.start} aria-hidden className="absolute inset-x-0 bg-[color-mix(in_srgb,var(--color-label-tertiary)_16%,transparent)]" style={{ top: y(o.start), height: y(o.end) - y(o.start) }} />
      ))}
      {busy.map((b) => {
        const external = b.kind === 'external';
        if (b.allDay) {
          // All day: busy (the server counts it) but a wash, not a wall — the hours stay readable.
          return (
            <div
              key={`${b.start}-${b.end}-${b.kind}-${b.eventId}`}
              role="img"
              aria-label={t('fb.busyAllDay', { name })}
              data-testid="busy-cell"
              data-kind="all-day"
              className="absolute inset-x-0"
              style={{ top: y(b.start), height: y(b.end) - y(b.start), background: `color-mix(in srgb, ${color} 12%, transparent)` }}
            />
          );
        }
        return (
          <div
            key={`${b.start}-${b.end}-${b.kind}-${b.eventId}`}
            role="img"
            aria-label={t(external ? 'fb.busyExternalAt' : 'fb.busyAt', { name, time: `${formatTime(b.start)} – ${formatTime(b.end)}` })}
            data-testid="busy-cell"
            data-kind={b.kind}
            className="absolute inset-x-0.5 rounded-[4px] border-l-[3px]"
            style={{
              top: y(b.start) + 1,
              height: Math.max(6, y(b.end) - y(b.start) - 2),
              borderColor: color,
              background: external
                ? `repeating-linear-gradient(135deg, color-mix(in srgb, ${color} 18%, transparent) 0 6px, color-mix(in srgb, ${color} 42%, transparent) 6px 9px)`
                : `color-mix(in srgb, ${color} 42%, var(--color-bg))`,
            }}
          />
        );
      })}
    </div>
  );
});

/**
 * The common free windows (green) over the columns, the only pointer target: a click takes the
 * duration from that point (inside the window), a drag selects a range in it (15-minute steps).
 */
const FreeOverlay = memo(function FreeOverlay({ ctl, onPick, highlight }: { ctl: FindCtl; onPick: (slot: Interval) => void; highlight: Interval | null }): ReactNode {
  const { workspaceId, users, day, durationMin, workHours } = ctl;
  const from = dayStart(day);
  const to = dayEnd(day);
  const sigs = useFreeBusy(useShallow((s) => users.map((u) => `${busySignature(s.entries[entryKey(workspaceId, u)], from, to)}#${hoursSignature(s.entries[entryKey(workspaceId, u)])}`)));
  // «Now» in 15-minute steps (the minute ticker; the windows recompute when a step passes).
  const now = Math.ceil(useNow(60_000) / (15 * MIN)) * 15 * MIN;
  const windows = useMemo(() => {
    if (!users.length || sigs.some((x) => x.endsWith('#'))) return [];
    const busy = sigs.map((x) => parseBusySignature(x.slice(0, x.lastIndexOf('#'))));
    const work = workHours
      ? sigs.map((x) => {
          const h = parseHoursSignature(x.slice(x.lastIndexOf('#') + 1));
          return h ? workIntervals(h.workHours, h.timezone, from, to) : [];
        })
      : null;
    // Not in the past.
    return freeWindows({ from: Math.max(from, Math.min(to, now)), to, busy, work, minMinutes: durationMin });
    // `now` in 15-minute steps: recomputed when the minute passes a step (with the day / people).
  }, [sigs, users.length, workHours, from, to, durationMin, now]);
  const [sel, setSel] = useState<Interval | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const minuteAt = (clientY: number): number => {
    const r = box.current?.getBoundingClientRect();
    return r ? Math.max(0, Math.min(24 * 60, Math.round((clientY - r.top) / PX_PER_MIN / 15) * 15)) : 0;
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>, w: Interval): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const anchor = from + minuteAt(e.clientY) * MIN;
    const y0 = e.clientY;
    let moved = false;
    const clip = (a: number, b: number): Interval => ({ start: Math.max(w.start, Math.min(a, b)), end: Math.min(w.end, Math.max(a, b)) });
    const move = (ev: PointerEvent): void => {
      if (!moved && Math.abs(ev.clientY - y0) < 4) return;
      moved = true;
      const at = from + minuteAt(ev.clientY) * MIN;
      setSel(clip(anchor, at === anchor ? anchor + 15 * MIN : at));
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setSel(null);
      if (ev.type === 'pointercancel') return;
      if (moved) {
        const at = from + minuteAt(ev.clientY) * MIN;
        const r = clip(anchor, at);
        if (r.end - r.start >= 15 * MIN) onPick(r);
        return;
      }
      // A click: the duration from the clicked quarter, kept inside the window.
      const len = durationMin * MIN;
      const start = Math.max(w.start, Math.min(Math.floor(anchor / (15 * MIN)) * 15 * MIN, w.end - len));
      onPick({ start, end: start + len });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const y = (ms: number): number => ((Math.max(from, Math.min(to, ms)) - from) / MIN) * PX_PER_MIN;
  const shown = sel ?? (highlight && highlight.start < to && highlight.end > from ? highlight : null);
  return (
    <div ref={box} className="pointer-events-none absolute inset-0 z-[1]" data-testid="free-overlay">
      {windows.map((w) => (
        <div
          key={w.start}
          role="button"
          tabIndex={-1}
          aria-label={t('fb.freeWindow', { time: `${formatTime(w.start)} – ${formatTime(w.end)}` })}
          data-testid="free-window"
          onPointerDown={(e) => onDown(e, w)}
          className="pointer-events-auto absolute inset-x-0 cursor-copy rounded-[4px] border border-[color-mix(in_srgb,var(--color-green)_55%,transparent)] bg-[color-mix(in_srgb,var(--color-green)_16%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-green)_24%,transparent)]"
          style={{ top: y(w.start), height: Math.max(4, y(w.end) - y(w.start)) }}
        />
      ))}
      {shown ? (
        <div
          className="absolute inset-x-0 z-[2] rounded-[6px] border-2 border-accent bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)]"
          style={{ top: y(shown.start), height: Math.max(12, y(shown.end) - y(shown.start)) }}
          data-testid="find-selection"
        >
          <span className="absolute left-1.5 top-0.5 rounded bg-accent-strong px-1 text-micro font-semibold tabular-nums text-accent-fg">
            {formatTime(shown.start)} – {formatTime(shown.end)}
          </span>
        </div>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------- «Ближайшие окна»

/** The server's nearest windows (≤ 10) from the shown day on; «Следующее окно» steps through them on the grid. */
function SlotList({ ctl, onPick, onShow }: { ctl: FindCtl; onPick: (slot: Interval) => void; onShow?: (slot: Interval | null) => void }): ReactNode {
  const { workspaceId, users, durationMin, workHours, day } = ctl;
  const [res, setRes] = useState<{ key: string; slots: Interval[]; status: 'ok' | 'hours' | 'fail' } | null>(null);
  const [cursor, setCursor] = useState(-1);
  // Busy time changes (EVENT_*, a new window loaded) ask the server again.
  const version = useFreeBusy((s) => s.rev);
  const reqKey = `${workspaceId}|${users.join(',')}|${durationMin}|${workHours ? 1 : 0}|${day}|${version}`;

  useEffect(() => {
    if (!users.length) return;
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      const start = Math.max(Math.ceil(Date.now() / (15 * MIN)) * 15 * MIN, dayStart(day));
      freebusyApi.suggest(workspaceId, { users, durationMin, from: start, to: start + SUGGEST_SPAN, withinWorkHours: workHours }, ac.signal).then(
        (slots) => {
          setRes({ key: reqKey, slots: slots.slice(0, 10), status: 'ok' });
          setCursor(-1);
        },
        (e: unknown) => {
          if (!ac.signal.aborted) setRes({ key: reqKey, slots: [], status: noCommonHours(e) ? 'hours' : 'fail' });
        },
      );
    }, 250);
    return () => {
      ac.abort();
      window.clearTimeout(timer);
    };
  }, [reqKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = !users.length
    ? { slots: [] as Interval[], status: 'idle' as const }
    : { slots: res?.slots ?? [], status: !res || res.key !== reqKey ? ('loading' as const) : res.status };

  const next = (): void => {
    const i = cursor + 1 < state.slots.length ? cursor + 1 : 0;
    const slot = state.slots[i];
    if (!slot) return;
    setCursor(i);
    const d = dayKey(slot.start);
    if (d !== day) ctl.setDay(d);
    onShow?.(slot);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="find-slots">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
        <h2 className="text-control font-semibold">{t('fb.slots')}</h2>
        {state.status === 'loading' ? <Spinner className="size-4" /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {state.status === 'idle' ? <p className="px-1 text-caption text-muted">{t('fb.addSomeone')}</p> : null}
        {state.status === 'hours' ? (
          <div className="flex flex-col items-start gap-2 rounded-[var(--radius-card)] bg-[var(--color-fill)] p-3" role="alert" data-testid="find-no-hours">
            <p className="text-caption text-fg">{t('fb.noCommonHours')}</p>
            <Button size="sm" variant="secondary" onClick={() => ctl.setWorkHours(false)}>
              {t('fb.anyHours')}
            </Button>
          </div>
        ) : null}
        {state.status === 'fail' ? <p className="px-1 text-caption text-danger-text">{t('fb.failed')}</p> : null}
        {state.status === 'ok' && state.slots.length === 0 ? <p className="px-1 text-caption text-muted">{t('fb.noSlots')}</p> : null}
        <ul className="flex flex-col gap-1">
          {state.slots.map((s, i) => (
            <li key={s.start}>
              <button
                type="button"
                onClick={() => onPick(s)}
                onMouseEnter={() => onShow && dayKey(s.start) === day && onShow(s)}
                className={cx(
                  'flex h-11 w-full flex-col justify-center rounded-[var(--radius-row)] px-2.5 text-left transition-colors duration-[var(--motion-fast)] hover:bg-hover',
                  i === cursor && 'bg-active',
                )}
                data-testid="find-slot"
              >
                <span className="text-caption text-muted first-letter:uppercase">{formatShortDay(s.start)}</span>
                <span className="text-body font-medium tabular-nums">
                  {formatTime(s.start)} – {formatTime(s.end)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {onShow && state.slots.length ? (
        <div className="shrink-0 border-t border-line p-2">
          <Button variant="secondary" size="sm" className="w-full" onClick={next} data-testid="find-next">
            <CalendarSearch className="size-3.5" aria-hidden />
            {t('fb.next')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
