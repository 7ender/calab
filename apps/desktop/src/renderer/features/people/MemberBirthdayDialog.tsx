import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Button, Field, Modal } from '../../components/ui';
import { t } from '../../i18n';
import type { BirthdayLike } from '../../lib/birthday';
import { useMemberName } from '../../stores/workspaces';
import { peopleError } from './actions';
import { BirthdayPicker, draftBirthday, type BirthdayDraft } from './BirthdayPicker';
import { saveMemberBirthday, useMemberBirthdays } from './memberBirthdays';

/**
 * «Изменить день рождения» of a member (docs/09 #77): the owner / an admin (MANAGE_NICKNAMES,
 * canEditMemberBirthday) sets the date with the same day · month · year selects as the profile
 * settings. A date the member hid stays hidden: the dialog says so and never touches the flag.
 */
export function MemberBirthdayDialog({ workspaceId, userId, onClose }: { workspaceId: string; userId: string; onClose: () => void }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const all = useMemberBirthdays(workspaceId);
  const current = all?.[userId];
  const saved = current?.birthday;
  const [draft, setDraft] = useState<BirthdayDraft | null>(null);
  const cur = draft ?? { day: saved?.day ?? 0, month: saved?.month ?? 0, year: saved?.year ?? 0 };
  const save = useMutation({
    mutationFn: (b: BirthdayLike | null) => saveMemberBirthday(workspaceId, userId, b),
    onSuccess: onClose,
  });
  const next = draftBirthday(cur);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('birthday.editTitle')}
      description={name}
      footer={
        <>
          {saved ? (
            <Button variant="ghost" className="mr-auto" disabled={save.isPending} onClick={() => save.mutate(null)}>
              {t('birthday.clear')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={save.isPending} disabled={!next || all === undefined} onClick={() => next && save.mutate(next)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div data-testid="member-birthday-dialog">
        <Field label={t('birthday.title')} hint={current?.hidden ? t('birthday.hiddenByUserHint') : t('birthday.adminHint')} error={save.error ? peopleError(save.error) : null}>
          <BirthdayPicker value={cur} onChange={setDraft} />
        </Field>
      </div>
    </Modal>
  );
}
