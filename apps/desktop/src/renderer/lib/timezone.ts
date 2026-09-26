/**
 * Member time zones (User.timezone, IANA): «(+3 UTC)» after a name when that person's offset
 * from UTC differs from mine (Discord style). Pure, unit-tested; offsets are taken for the given
 * moment, so daylight saving time is right on both sides.
 */

/** This device's IANA zone ('' when the runtime can't tell). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** Offset of `tz` from UTC at `at`, in minutes (east positive); null for an unknown zone. */
export function utcOffsetMinutes(tz: string, at: Date): number | null {
  if (!tz) return null;
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (!part) return null;
    if (part === 'GMT') return 0;
    const m = /^GMT([+-−])(\d{1,2})(?::(\d{2}))?$/.exec(part);
    if (!m) return null;
    const sign = m[1] === '+' ? 1 : -1;
    return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return null;
  }
}

/** «(+3 UTC)», «(−3:30 UTC)», «(UTC)» — the true minus sign, minutes only when not whole hours. */
export function formatUtcOffset(minutes: number): string {
  if (minutes === 0) return '(UTC)';
  const sign = minutes > 0 ? '+' : '−';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `(${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''} UTC)`;
}

/**
 * The label after a member's name, or null: their zone is unset / unknown, or its offset right
 * now equals mine (then the time is the same, no point in saying it).
 */
export function timeZoneLabel(theirs: string, mine: string, at: Date = new Date()): string | null {
  const t = utcOffsetMinutes(theirs, at);
  if (t === null) return null;
  const m = utcOffsetMinutes(mine, at);
  if (m !== null && m === t) return null;
  return formatUtcOffset(t);
}
