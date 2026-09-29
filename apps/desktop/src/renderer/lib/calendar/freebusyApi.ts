import { platform } from '../../platform';
import { ApiError, toApiError } from '../api/client';
import { DEFAULT_WORK_HOURS, type Interval, type WorkHours } from './freebusy';

/*
 * The free / busy, find-a-time and CalDAV endpoints of ADR-0041 (§1, §2, §4) as the client uses
 * them. INTERIM: the protobuf contract (FreeBusy*, SuggestSlots*, CalDav*, UserSettings.work_hours)
 * lands with the server branch; until it is generated this one module reads the protojson by hand
 * and maps it to the view types below. The swap is local to this file: `call(…, <Schema>)` and the
 * same mapping — nothing else in the client touches the wire.
 */

export type BusyKind = 'meeting' | 'external';

export interface BusyInterval extends Interval {
  /** Set only when the viewer may see that meeting (ADR-0041 §1, ADR-0038 §2). */
  eventId: string;
  kind: BusyKind;
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

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function json(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await platform.apiFetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('ERROR_CODE_UNAVAILABLE', err instanceof Error ? err.message : String(err), 0);
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return {};
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : {};
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);
const ms = (v: unknown): number => {
  const t = Date.parse(str(v));
  return Number.isNaN(t) ? 0 : t;
};

function workHoursOf(v: unknown): WorkHours {
  const o = obj(v);
  if (!('startMin' in o) && !('endMin' in o) && !('days' in o)) return DEFAULT_WORK_HOURS;
  const days = arr(o['days'])
    .map((d) => num(d))
    .filter((d) => d >= 1 && d <= 7);
  return { startMin: num(o['startMin']), endMin: num(o['endMin']), days: [...new Set(days)].sort((a, b) => a - b) };
}

function kindOf(v: unknown): BusyKind {
  // BusyKind: BUSY_KIND_MEETING = 1, BUSY_KIND_EXTERNAL = 2.
  return v === 'BUSY_KIND_EXTERNAL' || v === 2 ? 'external' : 'meeting';
}

function userOf(v: unknown): FreeBusyUser {
  const o = obj(v);
  return {
    userId: str(o['userId']),
    timezone: str(o['timezone']) || 'UTC',
    workHours: workHoursOf(o['workHours']),
    busy: arr(o['busy'])
      .map((b) => {
        const x = obj(b);
        return { start: ms(x['startsAt']), end: ms(x['endsAt']), eventId: str(x['eventId']), kind: kindOf(x['kind']), allDay: x['allDay'] === true };
      })
      .filter((b) => b.end > b.start),
  };
}

function accountOf(v: unknown): CalDavAccount | null {
  const a = obj(obj(v)['account']);
  if (!str(a['url'])) return null;
  return {
    url: str(a['url']),
    username: str(a['username']),
    calendarHref: str(a['calendarHref']),
    import: a['import'] === true,
    push: a['push'] === true,
    lastSyncAt: a['lastSyncAt'] ? ms(a['lastSyncAt']) || null : null,
    lastError: str(a['lastError']),
    calendars: arr(a['calendars']).map((c) => {
      const x = obj(c);
      return { href: str(x['href']), name: str(x['name']), color: str(x['color']) };
    }),
  };
}

const iso = (t: number): string => new Date(t).toISOString();

export const freebusyApi = {
  /** GET …/freebusy: ≤ 20 people, a window ≤ 14 days; 403 for guests and bots. */
  async get(workspaceId: string, users: readonly string[], from: number, to: number, signal?: AbortSignal): Promise<FreeBusyUser[]> {
    const q = new URLSearchParams({ users: users.join(','), from: iso(from), to: iso(to) });
    return arr(obj(await json('GET', `/api/workspaces/${workspaceId}/freebusy?${q.toString()}`, undefined, signal))['users']).map(userOf);
  },
  /** POST …/freebusy/suggest: ≤ 10 nearest windows; 409 NO_COMMON_HOURS (see `noCommonHours`). */
  async suggest(workspaceId: string, s: SuggestInit, signal?: AbortSignal): Promise<Interval[]> {
    const body = { users: s.users, durationMin: s.durationMin, from: iso(s.from), to: iso(s.to), withinWorkHours: s.withinWorkHours, ...(s.roomId ? { roomId: s.roomId } : {}) };
    return arr(obj(await json('POST', `/api/workspaces/${workspaceId}/freebusy/suggest`, body, signal))['slots'])
      .map((x) => ({ start: ms(obj(x)['startsAt']), end: ms(obj(x)['endsAt']) }))
      .filter((x) => x.end > x.start);
  },
  /** My work hours (Me.settings.work_hours; the default until set). */
  async myWorkHours(): Promise<WorkHours> {
    return workHoursOf(obj(obj(obj(await json('GET', '/api/me'))['me'])['settings'])['workHours']);
  },
  /** PATCH /api/me {work_hours}: the saved value. */
  async saveWorkHours(wh: WorkHours): Promise<WorkHours> {
    const r = await json('PATCH', '/api/me', { workHours: { startMin: wh.startMin, endMin: wh.endMin, days: wh.days } });
    const got = obj(obj(obj(r)['me'])['settings'])['workHours'];
    return got ? workHoursOf(got) : wh;
  },
  caldav: {
    /** null = no account. */
    get: async (): Promise<CalDavAccount | null> => accountOf(await json('GET', '/api/me/caldav')),
    /** Connects (the server discovers the calendars); 422 with a reason on a bad address / login. */
    connect: async (url: string, username: string, password: string): Promise<CalDavAccount | null> => accountOf(await json('POST', '/api/me/caldav', { url, username, password })),
    update: async (p: { calendarHref: string; import: boolean; push: boolean }): Promise<CalDavAccount | null> => accountOf(await json('PUT', '/api/me/caldav', p)),
    remove: async (): Promise<void> => {
      await json('DELETE', '/api/me/caldav');
    },
    /** A manual sync (≤ 1 a minute: 429). */
    sync: async (): Promise<CalDavAccount | null> => accountOf(await json('POST', '/api/me/caldav/sync')),
  },
};

/** 409 NO_COMMON_HOURS: the people's work hours never overlap (ADR-0041 §2). */
export const noCommonHours = (e: unknown): boolean => e instanceof ApiError && (e.code === 'ERROR_CODE_NO_COMMON_HOURS' || e.reason === 'NO_COMMON_HOURS');
