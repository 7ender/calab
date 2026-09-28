import { useState, type ReactNode } from 'react';
import { Button, Card, Row, Toggle } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { BirthdayPicker, draftBirthday, type BirthdayDraft } from '../people/BirthdayPicker';

/**
 * «Профиль → День рождения» (docs/09 #76): day and month (both, or none), the year optional,
 * «Скрыть от других». Each change is saved at once (PATCH /api/me) when the date is complete.
 */
export function BirthdaySettings(): ReactNode {
  const saved = useSession((s) => s.me?.user?.birthday);
  const hidden = useSession((s) => s.me?.birthdayHidden ?? false);
  // Half-picked date (a month without a day yet) lives here until it is complete.
  const [draft, setDraft] = useState<BirthdayDraft | null>(null);
  const cur = draft ?? { day: saved?.day ?? 0, month: saved?.month ?? 0, year: saved?.year ?? 0 };

  const save = (init: Parameters<typeof api.me.update>[0]): void => {
    void api.me
      .update(init)
      .then((r) => {
        if (r.me) useSession.getState().set({ me: r.me });
        setDraft(null);
      })
      .catch((e: unknown) => toast.fail(e, t('err.ctx.save')));
  };
  const pick = (v: BirthdayDraft): void => {
    setDraft(v);
    const b = draftBirthday(v);
    if (b) save({ birthday: b });
  };

  return (
    <Card title={t('birthday.title')} footer={saved ? t(hidden ? 'birthday.hiddenHint' : 'birthday.hint') : t('birthday.hint')}>
      <Row label={t('birthday.title')}>
        <span className="flex items-center gap-2">
          <BirthdayPicker value={cur} onChange={pick} />
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
