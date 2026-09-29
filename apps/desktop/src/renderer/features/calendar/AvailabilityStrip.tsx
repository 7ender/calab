import { TriangleAlert } from 'lucide-react';
import { memo, useEffect, useMemo, type ReactNode } from 'react';
import { t } from '../../i18n';
import { busyPeople, mergeIntervals, type Interval } from '../../lib/calendar/freebusy';
import { dayEnd, dayStart, formatMinutes } from '../../lib/calendar/time';
import { busySignature, ensureBusy, parseBusySignature } from '../../services/freebusy';
import { entryKey, useFreeBusy } from '../../stores/freebusy';
import { memberName } from '../../stores/workspaces';

const MIN = 60_000;

/**
 * Under the meeting dialog's times (ADR-0041 §3): a thin strip of the attendees' busy time around
 * the meeting (the meeting outlined, overlaps red) and a warning that does not block saving —
 * «В это время уже есть встреча: Анна». The meeting being edited is not its own conflict.
 */
export const AvailabilityStrip = memo(function AvailabilityStrip({
  workspaceId,
  users,
  day,
  start,
  end,
  eventId,
}: {
  workspaceId: string;
  /** Member attendees (not me, not external addresses), as a stable joined key's list. */
  users: readonly string[];
  day: string;
  /** Minutes after the day's midnight (the end may pass 24:00). */
  start: number;
  end: number;
  eventId: string;
}): ReactNode {
  const from = dayStart(day);
  const to = dayEnd(day);
  useEffect(() => ensureBusy(workspaceId, users, from, to + 86_400_000), [workspaceId, users, from, to]);
  const sig = useFreeBusy((s) => users.map((u) => `${u}#${busySignature(s.entries[entryKey(workspaceId, u)], from, to + 86_400_000)}`).join('¦'));
  const busy = useMemo(() => {
    const out: Record<string, Interval[]> = {};
    if (!sig) return out;
    for (const part of sig.split('¦')) {
      const at = part.indexOf('#');
      out[part.slice(0, at)] = parseBusySignature(part.slice(at + 1)).filter((b) => !eventId || b.eventId !== eventId);
    }
    return out;
  }, [sig, eventId]);
  if (!users.length) return null;

  const ms = (m: number): number => from + m * MIN;
  const who = busyPeople(busy, ms(start), ms(end));
  // The strip shows 08:00–20:00, widened to the meeting ± 1 h.
  const a = Math.max(0, Math.min(8 * 60, start - 60));
  const b = Math.min(24 * 60, Math.max(20 * 60, end + 60));
  const span = b - a;
  const x = (m: number): string => `${(Math.max(0, Math.min(span, m - a)) / span) * 100}%`;
  const all = mergeIntervals(Object.values(busy).flat()).map((i) => ({ s: (i.start - from) / MIN, e: (i.end - from) / MIN }));
  const hits = all.map((i) => ({ s: Math.max(i.s, start), e: Math.min(i.e, end) })).filter((i) => i.e > i.s);

  return (
    <div className="col-span-2 flex flex-col gap-1" data-testid="availability-strip">
      <div className="relative h-2.5 overflow-hidden rounded-full bg-[var(--color-fill)]" role="img" aria-label={t('fb.strip')}>
        {all.map((i) => (
          <span key={`${i.s}-${i.e}`} className="absolute inset-y-0 bg-[var(--color-label-tertiary)]" style={{ left: x(i.s), width: `calc(${x(i.e)} - ${x(i.s)})` }} />
        ))}
        {hits.map((i) => (
          <span key={`h${i.s}`} className="absolute inset-y-0 bg-danger" style={{ left: x(i.s), width: `calc(${x(i.e)} - ${x(i.s)})` }} />
        ))}
        <span className="absolute inset-y-0 rounded-full border-2 border-accent" style={{ left: x(start), width: `calc(${x(end)} - ${x(start)})` }} />
      </div>
      <div className="flex justify-between text-micro tabular-nums text-faint" aria-hidden>
        <span>{formatMinutes(a)}</span>
        <span>{formatMinutes(b % 1440)}</span>
      </div>
      {who.length ? (
        <p className="flex items-start gap-1.5 text-caption text-fg" role="status" data-testid="availability-conflict">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" aria-hidden />
          <span>{t(who.length === 1 ? 'fb.conflictOne' : 'fb.conflictMany', { names: who.map((u) => memberName(workspaceId, u)).join(', ') })}</span>
        </p>
      ) : null}
    </div>
  );
});
