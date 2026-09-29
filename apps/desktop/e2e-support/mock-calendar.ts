/**
 * Workspace calendar in the mock (ADR-0038): the stored meetings and their pure logic —
 * occurrence expansion, answers, counts, address masking, the signed-answer tokens of external
 * attendees. The routes and gateway fan-out live in mock-server.ts (`calendarRoutes`).
 *
 * Simplifications against the server: repeats are expanded in UTC (fixtures use UTC meetings),
 * no mail is sent, guest links are not made (`guestLinks` stays false).
 */
import { clone, create } from '@bufbuild/protobuf';
import { timestampFromMs, timestampMs } from '@bufbuild/protobuf/wkt';
import {
  AttendeeStatus,
  CalendarEventCountsSchema,
  CalendarEventSchema,
  EventRepeat,
  type CalendarEvent,
  type CalendarEventAttendee,
} from '@calaba/protocol';

/** A stored meeting: the series (occurrence_at unset), its cancelled occurrences and recordings. */
export interface CalEventRec {
  ev: CalendarEvent;
  /** Cancelled occurrence starts (ms). */
  exceptions: Set<number>;
  /** Recording of an occurrence: start (ms) → recording id. */
  recordings: Map<number, string>;
}

export interface Occurrence {
  startMs: number;
  endMs: number;
}

/** A room shows its meeting this long before the start (ADR-0038 §6). */
export const ACTIVE_BEFORE_MS = 15 * 60_000;

const DAY = 86_400_000;

function nth(startMs: number, repeat: EventRepeat, n: number): number | null {
  switch (repeat) {
    case EventRepeat.DAILY:
      return startMs + n * DAY;
    case EventRepeat.WEEKLY:
      return startMs + n * 7 * DAY;
    case EventRepeat.BIWEEKLY:
      return startMs + n * 14 * DAY;
    case EventRepeat.MONTHLY: {
      const d = new Date(startMs);
      const day = d.getUTCDate();
      d.setUTCMonth(d.getUTCMonth() + n);
      return d.getUTCDate() === day ? d.getTime() : null; // months without that day are skipped
    }
    default:
      return n === 0 ? startMs : null;
  }
}

/** Live occurrences of a series overlapping [fromMs, toMs), in order (≤ 500). */
export function occurrences(rec: CalEventRec, fromMs: number, toMs: number): Occurrence[] {
  const e = rec.ev;
  const start = e.startsAt ? timestampMs(e.startsAt) : 0;
  const dur = (e.endsAt ? timestampMs(e.endsAt) : start) - start;
  const until = e.repeatUntil ? timestampMs(e.repeatUntil) : Infinity;
  const out: Occurrence[] = [];
  for (let n = 0; n < 5000 && out.length < 500; n++) {
    const s = nth(start, e.repeat, n);
    if (s === null) {
      if (e.repeat === EventRepeat.UNSPECIFIED) break;
      continue;
    }
    if (s >= toMs || s > until) break;
    if (s + dur > fromMs && !rec.exceptions.has(s)) out.push({ startMs: s, endMs: s + dur });
  }
  return out;
}

/** The occurrence active at nowMs (from 15 minutes before its start until its end), if any. */
export function activeOccurrence(rec: CalEventRec, nowMs: number): Occurrence | null {
  if (!rec.ev.roomId || rec.ev.cancelledAt) return null;
  return occurrences(rec, nowMs, nowMs + ACTIVE_BEFORE_MS + 1).find((o) => nowMs >= o.startMs - ACTIVE_BEFORE_MS && nowMs < o.endMs) ?? null;
}

export function counts(attendees: readonly CalendarEventAttendee[]): ReturnType<typeof create<typeof CalendarEventCountsSchema>> {
  const c = create(CalendarEventCountsSchema);
  for (const a of attendees) {
    if (a.status === AttendeeStatus.ACCEPTED) c.accepted++;
    else if (a.status === AttendeeStatus.DECLINED) c.declined++;
    else if (a.status === AttendeeStatus.MAYBE) c.maybe++;
    else c.pending++;
  }
  return c;
}

export function involves(ev: CalendarEvent, userId: string): boolean {
  return ev.organizerId === userId || ev.attendees.some((a) => a.userId === userId);
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${Array.from(email.slice(0, at))[0] ?? ''}***${email.slice(at)}`;
}

/** How a viewer sees external addresses: in full, masked, or not at all (bots). */
export type EmailView = 'full' | 'masked' | 'none';

/**
 * The event as one viewer sees it: `occ` = one occurrence (lists), null = the series; `view`
 * applies to external addresses; `me` fills my_status / can_edit ('' = a gateway payload).
 */
export function eventOut(rec: CalEventRec, occ: Occurrence | null, view: EmailView, me: string, canEdit: boolean): CalendarEvent {
  const out = clone(CalendarEventSchema, rec.ev);
  out.counts = counts(out.attendees);
  out.cancelledOccurrences = [...rec.exceptions].sort((a, b) => a - b).map((ms) => timestampFromMs(ms));
  if (occ) {
    out.startsAt = timestampFromMs(occ.startMs);
    out.endsAt = timestampFromMs(occ.endMs);
    out.occurrenceAt = timestampFromMs(occ.startMs);
    out.recordingId = rec.recordings.get(occ.startMs) ?? '';
  }
  for (const a of out.attendees) {
    if (!a.email) continue;
    if (view === 'none') a.email = '';
    else if (view === 'masked') a.email = maskEmail(a.email);
  }
  if (me) {
    out.myStatus = out.attendees.find((a) => a.userId === me)?.status ?? AttendeeStatus.UNSPECIFIED;
    out.canEdit = canEdit;
  }
  return out;
}

/**
 * The mock's answer link token of an external attendee: `mock.<eventId>.<base64url(email)>.<status>`
 * (the server signs it; the mock only needs to round-trip it for the web page).
 */
export function rsvpToken(eventId: string, email: string, status: AttendeeStatus): string {
  return `mock.${eventId}.${Buffer.from(email).toString('base64url')}.${String(status)}`;
}

export function parseRsvpToken(tok: string): { eventId: string; email: string; status: AttendeeStatus } | null {
  const [pre, eventId, email, status] = tok.split('.');
  const st = Number(status);
  if (pre !== 'mock' || !eventId || !email || ![AttendeeStatus.ACCEPTED, AttendeeStatus.DECLINED, AttendeeStatus.MAYBE].includes(st)) return null;
  return { eventId, email: Buffer.from(email, 'base64url').toString(), status: st };
}

/** Allowed reminder minutes (ADR-0038 §1). */
export const REMINDER_CHOICES = [5, 10, 15, 30, 60, 120, 1440];
