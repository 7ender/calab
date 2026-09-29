import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { AttendeeStatus, CalendarEventAttendeeSchema, CalendarEventCountsSchema, CalendarEventSchema, EventRepeat, type CalendarEvent } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { applyCreate, applyDelete, applyRsvp, applyUpdate, keysIn, myStatusOf, occKey, replaceWindow, roomMeeting, withActive, withoutActive } from './events';

const H = 3_600_000;
const T0 = Date.parse('2026-01-15T12:00:00Z');
const ME = 'u-me';
const BOB = 'u-bob';

function ev(id: string, start: number, extra: MessageInitShape<typeof CalendarEventSchema> = {}): CalendarEvent {
  return create(CalendarEventSchema, {
    id,
    workspaceId: 'ws',
    title: id,
    startsAt: timestampFromMs(start),
    endsAt: timestampFromMs(start + H),
    occurrenceAt: timestampFromMs(start),
    organizerId: BOB,
    attendees: [
      create(CalendarEventAttendeeSchema, { userId: BOB, required: true, status: AttendeeStatus.ACCEPTED }),
      create(CalendarEventAttendeeSchema, { userId: ME, required: false, status: AttendeeStatus.PENDING }),
    ],
    counts: create(CalendarEventCountsSchema, { accepted: 1, pending: 1 }),
    ...extra,
  });
}

const map = (...xs: CalendarEvent[]) => Object.fromEntries(xs.map((x) => [occKey(x), x]));

describe('RSVP reducer (EVENT_RSVP)', () => {
  it('updates the attendee and the counts on every occurrence of the event', () => {
    const a = ev('e1', T0, { repeat: EventRepeat.DAILY });
    const b = ev('e1', T0 + 24 * H, { repeat: EventRepeat.DAILY });
    const other = ev('e2', T0);
    const answer = create(CalendarEventAttendeeSchema, { userId: ME, required: false, status: AttendeeStatus.MAYBE });
    const counts = create(CalendarEventCountsSchema, { accepted: 1, maybe: 1 });
    const next = applyRsvp(map(a, b, other), 'e1', answer, counts);
    for (const k of [occKey(a), occKey(b)]) {
      expect(myStatusOf(next[k] as CalendarEvent, ME)).toBe(AttendeeStatus.MAYBE);
      expect(next[k]?.counts?.maybe).toBe(1);
    }
    expect(next[occKey(other)]).toBe(other); // untouched object
  });

  it('my_status from the list gives way to the new answer', () => {
    const a = ev('e1', T0, { myStatus: AttendeeStatus.PENDING });
    const next = applyRsvp(map(a), 'e1', create(CalendarEventAttendeeSchema, { userId: ME, status: AttendeeStatus.DECLINED }), undefined);
    expect(myStatusOf(next[occKey(a)] as CalendarEvent, ME)).toBe(AttendeeStatus.DECLINED);
  });

  it('an unknown event leaves the map as it is', () => {
    const m = map(ev('e1', T0));
    expect(applyRsvp(m, 'nope', create(CalendarEventAttendeeSchema, { userId: ME, status: AttendeeStatus.ACCEPTED }), undefined)).toBe(m);
  });

  it('an external attendee is matched by address', () => {
    const a = ev('e1', T0, { attendees: [create(CalendarEventAttendeeSchema, { email: 'x@example.com', status: AttendeeStatus.PENDING })] });
    const next = applyRsvp(map(a), 'e1', create(CalendarEventAttendeeSchema, { email: 'x@example.com', status: AttendeeStatus.ACCEPTED }), undefined);
    expect(next[occKey(a)]?.attendees).toHaveLength(1);
    expect(next[occKey(a)]?.attendees[0]?.status).toBe(AttendeeStatus.ACCEPTED);
  });
});

describe('gateway events on the listed occurrences', () => {
  it('EVENT_CREATE: a single meeting goes in, a series asks for a list', () => {
    const one = ev('e1', T0, { occurrenceAt: undefined });
    const r = applyCreate({}, one);
    expect(r.refetch).toBe(false);
    expect(Object.keys(r.occ)).toEqual([`e1@${T0}`]);
    expect(applyCreate({}, ev('e2', T0, { repeat: EventRepeat.WEEKLY })).refetch).toBe(true);
  });

  it('EVENT_UPDATE: a single meeting moves at once (new key), a series refetches', () => {
    const a = ev('e1', T0);
    const moved = ev('e1', T0 + 2 * H, { occurrenceAt: undefined, title: 'Новое' });
    const r = applyUpdate(map(a), moved);
    expect(r.refetch).toBe(false);
    expect(Object.keys(r.occ)).toEqual([`e1@${T0 + 2 * H}`]);
    expect(Object.values(r.occ)[0]?.title).toBe('Новое');
    const s = ev('e2', T0, { repeat: EventRepeat.DAILY });
    const r2 = applyUpdate(map(s), ev('e2', T0, { repeat: EventRepeat.DAILY, title: 'x', occurrenceAt: undefined }));
    expect(r2.refetch).toBe(true);
    expect(r2.occ[occKey(s)]?.title).toBe('x');
    expect(r2.occ[occKey(s)]?.startsAt).toEqual(s.startsAt); // the occurrence keeps its own time
  });

  it('EVENT_UPDATE: an occurrence cancelled one by one leaves', () => {
    const a = ev('e1', T0, { repeat: EventRepeat.DAILY });
    const b = ev('e1', T0 + 24 * H, { repeat: EventRepeat.DAILY });
    const r = applyUpdate(map(a, b), ev('e1', T0, { repeat: EventRepeat.DAILY, occurrenceAt: undefined, cancelledOccurrences: [timestampFromMs(T0 + 24 * H)] }));
    expect(Object.keys(r.occ)).toEqual([occKey(a)]);
  });

  it('EVENT_DELETE removes every occurrence', () => {
    const a = ev('e1', T0);
    const b = ev('e2', T0);
    expect(Object.keys(applyDelete(map(a, b), 'e1'))).toEqual([occKey(b)]);
  });

  it('a list replaces its window of one workspace', () => {
    const old = ev('e1', T0);
    const outside = ev('e3', T0 + 40 * 24 * H);
    const otherWs = ev('e4', T0, { workspaceId: 'ws2' });
    const fresh = ev('e2', T0 + H);
    const next = replaceWindow(map(old, outside, otherWs), 'ws', T0 - 24 * H, T0 + 24 * H, [fresh]);
    expect(Object.keys(next).sort()).toEqual([occKey(fresh), occKey(outside), occKey(otherWs)].sort());
  });

  it('keysIn: a day’s occurrences, earliest first', () => {
    const a = ev('a', T0 + 2 * H);
    const b = ev('b', T0);
    const c = ev('c', T0 + 30 * H);
    expect(keysIn(map(a, b, c), 'ws', T0 - H, T0 + 12 * H)).toEqual([occKey(b), occKey(a)]);
  });
});

describe('room badges (ROOM_EVENT_ACTIVE / ENDED)', () => {
  it('keeps the active meetings of a room, earliest first', () => {
    const a = ev('a', T0, { roomId: 'r' });
    const b = ev('b', T0 - H, { roomId: 'r' });
    let m = withActive({}, 'r', a);
    m = withActive(m, 'r', b);
    expect(roomMeeting(m, 'r')?.id).toBe('b');
    m = withoutActive(m, 'r', 'b', T0 - H);
    expect(roomMeeting(m, 'r')?.id).toBe('a');
    m = withoutActive(m, 'r', 'a', null);
    expect(m['r']).toBeUndefined();
  });
});
