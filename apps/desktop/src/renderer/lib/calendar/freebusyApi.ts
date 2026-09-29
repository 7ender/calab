import { timestampFromMs, timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import {
  BusyKind,
  CalDavAccountResponseSchema,
  ConnectCalDavRequestSchema,
  FreeBusyResponseSchema,
  SuggestSlotsRequestSchema,
  SuggestSlotsResponseSchema,
  UpdateCalDavRequestSchema,
  type CalDavAccountResponse,
  type FreeBusyUser as WireUser,
  type WorkHours as WireWorkHours,
} from '@calaba/protocol';
import { api } from '../api/endpoints';
import { ApiError, body, call, callEmpty, qs } from '../api/client';
import { DEFAULT_WORK_HOURS, type Interval, type WorkHours } from './freebusy';

/*
 * The free / busy, find-a-time and CalDAV endpoints of ADR-0041 (§1, §2, §4) through the generated
 * contract (event.proto FreeBusy* / SuggestSlots* / CalDav*, user.proto WorkHours), mapped to the
 * client's view types in plain milliseconds (what the grid, the store and the pure math use).
 */

export type BusyKindName = 'meeting' | 'external';

export interface BusyInterval extends Interval {
  /** Set only when the viewer may see that meeting (ADR-0041 §1, ADR-0038 §2). */
  eventId: string;
  kind: BusyKindName;
  allDay: boolean;
}

export interface FreeBusyUser {
  userId: string;
  timezone: string;
  workHours: WorkHours;
  busy: BusyInterval[];
}

export interface CalDavCalendar {
  href: string;
  name: string;
  color: string;
}

export interface CalDavAccount {
  url: string;
  username: string;
  calendarHref: string;
  import: boolean;
  push: boolean;
  lastSyncAt: number | null;
  lastError: string;
  calendars: CalDavCalendar[];
}

export interface SuggestInit {
  users: readonly string[];
  durationMin: number;
  from: number;
  to: number;
  withinWorkHours: boolean;
  roomId?: string;
}

const ms = (t: Timestamp | undefined): number => (t ? timestampMs(t) : 0);

export function workHoursOf(w: WireWorkHours | undefined): WorkHours {
  if (!w || w.endMin <= w.startMin) return DEFAULT_WORK_HOURS;
  return { startMin: w.startMin, endMin: w.endMin, days: [...new Set(w.days.filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b) };
}

function userOf(u: WireUser): FreeBusyUser {
  return {
    userId: u.userId,
    timezone: u.timezone || 'UTC',
    workHours: workHoursOf(u.workHours),
    busy: u.busy
      .map((b) => ({ start: ms(b.startsAt), end: ms(b.endsAt), eventId: b.eventId, kind: b.kind === BusyKind.EXTERNAL ? ('external' as const) : ('meeting' as const), allDay: b.allDay }))
      .filter((b) => b.end > b.start),
  };
}

function accountOf(r: CalDavAccountResponse): CalDavAccount | null {
  const a = r.account;
  if (!a?.url) return null;
  return {
    url: a.url,
    username: a.username,
    calendarHref: a.calendarHref,
    import: a.import,
    push: a.push,
    lastSyncAt: a.lastSyncAt ? ms(a.lastSyncAt) : null,
    lastError: a.lastError,
    calendars: a.calendars.map((c) => ({ href: c.href, name: c.name, color: c.color })),
  };
}

const iso = (t: number): string => new Date(t).toISOString();

export const freebusyApi = {
  /** GET …/freebusy: ≤ 20 people, a window ≤ 14 days; 403 for guests and bots. */
  async get(workspaceId: string, users: readonly string[], from: number, to: number, signal?: AbortSignal): Promise<FreeBusyUser[]> {
    const r = await call('GET', `/api/workspaces/${workspaceId}/freebusy${qs({ users: users.join(','), from: iso(from), to: iso(to) })}`, FreeBusyResponseSchema, undefined, signal);
    return r.users.map(userOf);
  },
  /** POST …/freebusy/suggest: ≤ 10 nearest windows; 409 NO_COMMON_HOURS (see `noCommonHours`). */
  async suggest(workspaceId: string, s: SuggestInit, signal?: AbortSignal): Promise<Interval[]> {
    const req = body(SuggestSlotsRequestSchema, {
      users: [...s.users],
      durationMin: s.durationMin,
      from: timestampFromMs(s.from),
      to: timestampFromMs(s.to),
      withinWorkHours: s.withinWorkHours,
      roomId: s.roomId ?? '',
    });
    const r = await call('POST', `/api/workspaces/${workspaceId}/freebusy/suggest`, SuggestSlotsResponseSchema, req, signal);
    return r.slots.map((x) => ({ start: ms(x.startsAt), end: ms(x.endsAt) })).filter((x) => x.end > x.start);
  },
  /** PATCH /api/me {work_hours}: the updated Me. */
  saveWorkHours: (wh: WorkHours) => api.me.update({ workHours: { startMin: wh.startMin, endMin: wh.endMin, days: [...wh.days] } }),
  caldav: {
    /** null = no account. */
    get: async (): Promise<CalDavAccount | null> => accountOf(await call('GET', '/api/me/caldav', CalDavAccountResponseSchema)),
    /** Connects (the server discovers the calendars); 422 url / password when it cannot be used. */
    connect: async (url: string, username: string, password: string): Promise<CalDavAccount | null> =>
      accountOf(await call('POST', '/api/me/caldav', CalDavAccountResponseSchema, body(ConnectCalDavRequestSchema, { url, username, password }))),
    update: async (p: { calendarHref: string; import: boolean; push: boolean }): Promise<CalDavAccount | null> =>
      accountOf(await call('PUT', '/api/me/caldav', CalDavAccountResponseSchema, body(UpdateCalDavRequestSchema, p))),
    remove: (): Promise<void> => callEmpty('DELETE', '/api/me/caldav'),
    /** A manual sync (≤ 1 a minute: 429). */
    sync: async (): Promise<CalDavAccount | null> => accountOf(await call('POST', '/api/me/caldav/sync', CalDavAccountResponseSchema)),
  },
};

/** 409 NO_COMMON_HOURS: the people's work hours never overlap (ADR-0041 §2). */
export const noCommonHours = (e: unknown): boolean => e instanceof ApiError && (e.code === 'ERROR_CODE_NO_COMMON_HOURS' || e.reason === 'NO_COMMON_HOURS');
