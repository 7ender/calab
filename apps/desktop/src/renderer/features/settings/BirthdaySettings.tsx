import { useState, type ReactNode } from 'react';
import { Button, Card, Row, Select, Toggle } from '../../components/ui';
import { getLocale, t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { daysInMonth } from '../../lib/birthday';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';

/** «январь» … «декабрь» in the UI language (the stand-alone month name). */
function monthNames(): string[] {
  const f = new Intl.DateTimeFormat(getLocale(), { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2000, i, 1, 12))));
}

/**
 * «Профиль → День рождения» (docs/09 #76): day and month (both, or none), the year optional,
 * «Скрыть от других». Each change is saved at once (PATCH /api/me) when the date is complete;
 * the day list follows the month (and the year: 29 February only in leap years).
 */
export function BirthdaySettings(): ReactNode {
  const saved = useSession((s) => s.me?.user?.birthday);
  const hidden = useSession((s) => s.me?.birthdayHidden ?? false);
  // Half-picked date (a month without a day yet) lives here until it is complete.
  const [draft, setDraft] = useState<{ day: number; month: number; year: number } | null>(null);
  const cur = draft ?? { day: saved?.day ?? 0, month: saved?.month ?? 0, year: saved?.year ?? 0 };
  const thisYear = new Date().getFullYear();
  const months = monthNames();

  const save = (init: Parameters<typeof api.me.update>[0]): void => {
    void api.me
      .update(init)
      .then((r) => {
        if (r.me) useSession.getState().set({ me: r.me });
        setDraft(null);
      })
      .catch((e: unknown) => toast.fail(e, t('err.ctx.save')));
  };
  const pick = (next: { day: number; month: number; year: number }): void => {
    // A day that does not exist in the new month / year snaps to the month's last day.
    const max = next.month ? daysInMonth(next.month, next.year || undefined) : 31;
    const v = { ...next, day: Math.min(next.day, max) };
    setDraft(v);
    if (v.day && v.month) {
      save({ birthday: v.year ? { day: v.day, month: v.month, year: v.year } : { day: v.day, month: v.month } });
    }
  };
  const days = daysInMonth(cur.month || 1, cur.year || undefined);

  return (
    <Card title={t('birthday.title')} footer={saved ? t(hidden ? 'birthday.hiddenHint' : 'birthday.hint') : t('birthday.hint')}>
      <Row label={t('birthday.title')}>
        <span className="flex items-center gap-2" data-testid="birthday-picker">
          <Select aria-label={t('birthday.day')} className="w-[72px]" value={cur.day} onChange={(e) => pick({ ...cur, day: Number(e.target.value) })}>
            <option value={0}>{t('birthday.day')}</option>
            {Array.from({ length: cur.month ? days : 31 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </Select>
          <Select aria-label={t('birthday.month')} className="w-32" value={cur.month} onChange={(e) => pick({ ...cur, month: Number(e.target.value) })}>
            <option value={0}>{t('birthday.month')}</option>
            {months.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </Select>
          <Select aria-label={t('birthday.year')} className="w-[104px]" value={cur.year} onChange={(e) => pick({ ...cur, year: Number(e.target.value) })}>
            <option value={0}>{t('birthday.yearNone')}</option>
            {Array.from({ length: thisYear - 1900 + 1 }, (_, i) => thisYear - i).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
          {saved ? (
            <Button variant="secondary" onClick={() => save({ birthday: { day: 0, month: 0 } })}>
              {t('birthday.clear')}
            </Button>
          ) : null}
        </span>
      </Row>
      {saved ? (
        <Row label={t('birthday.hide')}>
          <Toggle checked={hidden} onChange={(v) => save({ birthdayHidden: v })} label={t('birthday.hide')} />
        </Row>
      ) : null}
    </Card>
  );
}
