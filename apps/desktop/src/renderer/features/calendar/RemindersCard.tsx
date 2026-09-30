import { useState, type ReactNode } from 'react';
import { Card, Row, Toggle, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { DEFAULT_REMINDERS, REMINDER_CHOICES, reminderChip, toggleReminder } from '../../lib/calendar/reminders';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';

/**
 * Settings → Уведомления → «Напоминания о встречах» (ADR-0038 §5): up to five chips of 5 / 10 /
 * 15 / 30 / 60 / 120 minutes and 1 day, and «Напоминать при "Не беспокоить"». Saved with
 * PATCH /api/me (event_reminders); the server's value comes back in USER_UPDATE.
 */
export function RemindersCard(): ReactNode {
  const settings = useSession((s) => s.me?.settings);
  const guest = useSession((s) => s.me?.user?.isGuest === true);
  const [pending, setPending] = useState<{ minutes: number[]; dnd: boolean } | null>(null);
  if (guest) return null;
  const minutes = pending?.minutes ?? (settings ? [...settings.eventReminders] : [...DEFAULT_REMINDERS]);
  const dnd = pending?.dnd ?? settings?.eventRemindersDnd ?? true;

  const save = async (next: { minutes: number[]; dnd: boolean }): Promise<void> => {
    setPending(next);
    try {
      const r = await api.me.update({ eventReminders: next });
      if (r.me) useSession.getState().set({ me: r.me });
    } catch (e) {
      toast.fail(e, t('err.ctx.save'));
    } finally {
      setPending(null);
    }
  };

  return (
    <Card title={t('cal.remindersTitle')} footer={t('cal.remindersHint')}>
      <Row label={t('cal.remindersLabel')}>
        <div role="group" aria-label={t('cal.remindersLabel')} className="flex max-w-[300px] flex-wrap justify-end gap-1.5" data-testid="reminder-chips">
          {REMINDER_CHOICES.map((m) => {
            const on = minutes.includes(m);
            return (
              <button
                key={m}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = toggleReminder(minutes, m);
                  if (!next) {
                    toast.info(t('cal.remindersMax'));
                    return;
                  }
                  void save({ minutes: next, dnd });
                }}
                className={cx(
                  'h-7 rounded-full px-3 text-control font-medium tabular-nums transition-colors duration-[var(--motion-fast)]',
                  on ? 'bg-accent-strong text-accent-fg' : 'bg-[var(--color-fill)] text-fg hover:bg-[var(--color-fill-hover)]',
                )}
              >
                {reminderChip(m)}
              </button>
            );
          })}
        </div>
      </Row>
      <Row label={t('cal.remindDnd')}>
        <Toggle label={t('cal.remindDnd')} checked={dnd} onChange={(v) => void save({ minutes, dnd: v })} />
      </Row>
    </Card>
  );
}
