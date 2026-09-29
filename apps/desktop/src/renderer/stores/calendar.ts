import { create } from 'zustand';
import type { CalendarEvent } from '@calaba/protocol';
import type { ActiveMap, OccMap } from '../lib/calendar/events';

/**
 * Workspace calendar (ADR-0038): the occurrences the client has listed (by `<id>@<start ms>`), the
 * meetings active in rooms (READY `active_events`, ROOM_EVENT_ACTIVE / ENDED), today's count for
 * the header icon. services/calendar.ts fills it; the pure transitions are lib/calendar/events.ts.
 * Components select an occurrence by key or a room's meeting by room id — never the whole map.
 */
interface CalendarState {
  occ: OccMap;
  /** Room id → its active meetings, earliest first. */
  active: ActiveMap;
  /** Listed month windows: `<workspace id>|YYYY-MM` → true (a refetch keeps the flag). */
  months: Readonly<Record<string, true>>;
  /** My upcoming meetings of today (all workspaces): the header icon's number. */
  todayCount: number;
  /** A series fetched by id (deep link `/e/<id>`): shown when no listed occurrence has it. */
  series: Readonly<Record<string, CalendarEvent>>;
  /** Recording prompts answered («Начать» / «Не сейчас»), per occurrence key: once each. */
  prompted: Readonly<Record<string, true>>;
  /** A room whose header badge opens its meeting card (a guest's /e/<id>); cleared when it closes. */
  badgeOpen: string | null;
  reset: () => void;
}

export const useCalendar = create<CalendarState>()((set) => ({
  occ: {},
  active: {},
  months: {},
  todayCount: 0,
  series: {},
  prompted: {},
  badgeOpen: null,
  reset: () => set({ occ: {}, active: {}, months: {}, todayCount: 0, series: {}, badgeOpen: null }),
}));
