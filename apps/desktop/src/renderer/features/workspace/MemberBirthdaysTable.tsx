import { WorkspaceRole, type MemberBirthday } from '@calaba/protocol';
import { ChevronLeft, EyeOff } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Avatar } from '../../components/Avatar';
import { Button, Card, Empty, Input, Spinner, cx } from '../../components/ui';
import { getLocale, t } from '../../i18n';
import { formatBirthdayField, parseBirthdayField } from '../../lib/birthday';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { rolesOf, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { saveMemberBirthday, useMemberBirthdays } from '../people/memberBirthdays';
import { canEditMemberBirthday } from '../people/members';

/**
 * «Участники → Дни рождения» (docs/09 #77, for HR): every member but bots and guests, a date
 * field right in the row saved on Enter / blur («15.03.1990», the year optional, empty clears).
 * A date the member hid is shown here marked «скрыто пользователем» — nobody else sees it, and
 * the admin cannot unhide it. Rows are memoised with their own selectors: an edit re-renders
 * one row (Ререндеры под контролем).
 */
export function MemberBirthdaysTable({ workspaceId, onBack }: { workspaceId: string; onBack: () => void }): ReactNode {
  const ids = useWorkspaces(
    useShallow((s) => {
      const members = Object.values(s.byId[workspaceId]?.members ?? {}).filter((m) => m.user && !m.user.isBot && !m.user.isGuest && m.role !== WorkspaceRole.GUEST);
      const name = (m: (typeof members)[number]): string => m.nickname || m.user?.displayName || '';
      return members.sort((a, b) => name(a).localeCompare(name(b), getLocale())).map((m) => m.user?.id ?? '');
    }),
  );
  const all = useMemberBirthdays(workspaceId);
  const example = formatBirthdayField({ day: 15, month: 3, year: 1990 });
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onBack} data-testid="birthdays-back">
          <ChevronLeft className="size-4" aria-hidden /> {t('ws.members')}
        </Button>
        <h3 className="min-w-0 truncate text-headline font-semibold">{t('birthday.tableTitle')}</h3>
      </div>
      {all === undefined ? (
        <Spinner />
      ) : ids.length === 0 ? (
        <Empty>{t('ws.filter.none')}</Empty>
      ) : (
        <Card title={t('card.members', { n: ids.length })} footer={t('birthday.tableHint', { example })}>
          {ids.map((id) => (
            <BirthdayRow key={id} workspaceId={workspaceId} userId={id} value={all[id]} placeholder={example} />
          ))}
        </Card>
      )}
    </>
  );
}

const BirthdayRow = memo(function BirthdayRow({
  workspaceId,
  userId,
  value,
  placeholder,
}: {
  workspaceId: string;
  userId: string;
  value: MemberBirthday | undefined;
  placeholder: string;
}): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const name = useMemberName(workspaceId, userId);
  const avatar = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]?.user?.avatarFileId ?? '');
  const editable = useWorkspaces((s) => {
    const e = s.byId[workspaceId];
    const m = e?.members[userId];
    return !!m && canEditMemberBirthday(rolesOf(e, me), rolesOf(e, userId), m, userId === me);
  });
  const shown = formatBirthdayField(value?.birthday);
  const [text, setText] = useState(shown);
  const [prev, setPrev] = useState(shown);
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);
  if (prev !== shown) {
    setPrev(shown);
    setText(shown);
    setBad(false);
  }
  const commit = (): void => {
    const next = parseBirthdayField(text);
    if (next === 'invalid') {
      setBad(true);
      return;
    }
    setBad(false);
    const normal = formatBirthdayField(next ?? undefined);
    if (normal === shown) {
      setText(shown);
      return;
    }
    setText(normal);
    setBusy(true);
    saveMemberBirthday(workspaceId, userId, next)
      .catch((e: unknown) => {
        toast.fail(e, t('err.ctx.save'));
        setText(shown);
      })
      .finally(() => setBusy(false));
  };
  const label = t('birthday.fieldLabel', { name });
  return (
    <div className="flex min-h-12 items-center gap-3 px-3 py-2" data-testid="birthday-row">
      <Avatar userId={userId} name={name} fileId={avatar || undefined} size={32} />
      <div className="min-w-0 flex-1 truncate text-body font-medium" title={name}>
        {name}
      </div>
      {value?.hidden ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-caption text-muted" title={t('birthday.hiddenByUserHint')} data-testid="birthday-hidden">
          <EyeOff className="size-3.5" aria-hidden />
          {t('birthday.hiddenByUser')}
        </span>
      ) : null}
      {editable ? (
        <span className="flex w-32 shrink-0 flex-col">
          <Input
            aria-label={label}
            aria-invalid={bad || undefined}
            title={bad ? t('birthday.fieldInvalid') : undefined}
            value={text}
            placeholder={placeholder}
            inputMode="numeric"
            maxLength={10}
            disabled={busy}
            className={cx('tabular-nums', bad && 'border-danger outline-danger')}
            onChange={(e) => {
              setText(e.target.value);
              if (bad) setBad(false);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape' && (text !== shown || bad)) {
                // Esc restores the saved date; only a second Esc closes the window.
                e.preventDefault();
                e.stopPropagation();
                setText(shown);
                setBad(false);
              }
            }}
          />
        </span>
      ) : (
        <span className="w-32 shrink-0 pl-2 text-body tabular-nums text-muted" aria-label={label}>
          {shown || '—'}
        </span>
      )}
    </div>
  );
});
