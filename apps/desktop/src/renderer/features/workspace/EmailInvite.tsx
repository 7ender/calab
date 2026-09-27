import { WorkspaceRole } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Badge, Button, Card, IconButton, Input, Select, Spinner } from '../../components/ui';
import { plural, t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { errorText } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { toast } from '../../stores/toasts';
import { useWorkspaces } from '../../stores/workspaces';
import { EmailLookup, type LookupState } from './emailLookup';

/** A failed add / invitation: 429 of «the same address < 24 h ago» names the wait. */
function sendError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409) return t('mail.invite.already');
    if (e.status === 429) {
      const h = Math.max(1, Math.ceil((e.retryAfter ?? 3600) / 3600));
      return e.retryAfter && e.retryAfter > 3600 ? plural('mail.invite.again', h) : t('mail.err.rate');
    }
  }
  return errorText(e);
}

/**
 * «Пригласить по email» (ADR-0023, docs/08 «Почта»), on top of the invitations tab: an exact
 * address → the account's card with «Добавить» (a member at once), or «Отправить приглашение на
 * почту» (a single-use link for 7 days, bound to the address). Below — the pending invitations
 * with «Отозвать». The links by code stay as they are.
 */
export function EmailInviteCard({ workspaceId }: { workspaceId: string }): ReactNode {
  const owner = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.OWNER);
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const [role, setRole] = useState(WorkspaceRole.MEMBER);
  const [state, setState] = useState<LookupState>({ kind: 'idle' });
  const [lookup] = useState(() => new EmailLookup({ lookup: (email, signal) => api.workspaces.lookupInvitee(workspaceId, email, signal), onChange: setState }));
  useEffect(() => () => lookup.dispose(), [lookup]);

  const reset = (): void => {
    setValue('');
    lookup.input('');
  };
  const add = useMutation({
    mutationFn: (userId: string) => api.workspaces.addMember(workspaceId, userId),
    onSuccess: (r) => {
      if (r.member) useWorkspaces.getState().upsertMember(r.member);
      toast.success(t('mail.invite.added', { name: r.member?.user?.displayName ?? '' }));
      reset();
    },
  });
  const invite = useMutation({
    mutationFn: (email: string) => api.workspaces.createEmailInvite(workspaceId, email, owner ? role : undefined),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['email-invites', workspaceId] });
      toast.success(t('mail.invite.sent', { email: r.invite?.email ?? '' }));
      reset();
    },
  });
  const failure = add.error ?? invite.error;

  return (
    <Card title={t('mail.invite.title')} footer={t('mail.invite.hint')}>
      <div className="flex flex-col gap-3 px-3 py-3" data-testid="invite-email">
        <label className="relative flex items-center">
          <Mail className="pointer-events-none absolute left-2 size-3.5 text-muted mobile:left-3" aria-hidden />
          <Input
            type="email"
            aria-label={t('mail.invite.field')}
            placeholder={t('mail.invite.placeholder')}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              add.reset();
              invite.reset();
              lookup.input(e.target.value);
            }}
            className="pl-7 mobile:pl-9"
          />
        </label>
        <div aria-live="polite" className="empty:hidden">
          {state.kind === 'searching' ? (
            <div className="flex min-h-10 items-center gap-2 text-caption text-muted">
              <Spinner className="size-4" />
              {t('mail.invite.searching')}
            </div>
          ) : null}
          {state.kind === 'found' ? (
            <div className="flex min-h-12 items-center gap-3 rounded-[var(--radius-card)] bg-[var(--color-fill-hover)] px-3 py-2" data-testid="invite-email-found">
              <Avatar userId={state.user.id} name={state.user.displayName} fileId={state.user.avatarFileId || undefined} size={32} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-body font-medium" title={state.user.displayName}>
                  {state.user.displayName}
                </div>
                <div className="truncate text-caption text-faint">{state.email}</div>
              </div>
              {state.member ? (
                <Badge>{t('mail.invite.member')}</Badge>
              ) : (
                <Button busy={add.isPending} onClick={() => add.mutate(state.user.id)}>
                  {t('mail.invite.add')}
                </Button>
              )}
            </div>
          ) : null}
          {state.kind === 'none' ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="invite-email-none">
              <p className="min-w-0 flex-1 basis-48 text-caption text-muted">{t('mail.invite.none', { email: state.email })}</p>
              {owner ? (
                <Select aria-label={t('mail.invite.role')} className="w-40" value={role} onChange={(e) => setRole(Number(e.target.value))}>
                  <option value={WorkspaceRole.MEMBER}>{t('role.member')}</option>
                  <option value={WorkspaceRole.ADMIN}>{t('role.admin')}</option>
                </Select>
              ) : null}
              <Button busy={invite.isPending} onClick={() => invite.mutate(state.email)}>
                {t('mail.invite.send')}
              </Button>
            </div>
          ) : null}
          {state.kind === 'error' ? (
            <p className="text-caption text-danger-text" role="alert">
              {state.text}
            </p>
          ) : null}
          {failure ? (
            <p className="mt-2 text-caption text-danger-text" role="alert">
              {sendError(failure)}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/** «Отправленные приглашения»: pending email invitations, newest first, with «Отозвать». */
export function EmailInvitesList({ workspaceId }: { workspaceId: string }): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['email-invites', workspaceId], queryFn: () => api.workspaces.emailInvites(workspaceId) });
  const revoke = useMutation({
    mutationFn: (id: string) => api.workspaces.revokeEmailInvite(workspaceId, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['email-invites', workspaceId] });
      toast.success(t('mail.invite.revoked'));
    },
    onError: (e) => toast.fail(e),
  });
  const invites = q.data?.invites ?? [];
  if (!invites.length) return null;
  return (
    <Card title={t('mail.invite.pending')}>
      {invites.map((i) => (
        <div key={i.id} className="flex min-h-10 items-center gap-3 px-3 py-2">
          <span className="selectable min-w-0 flex-1 truncate text-body" title={i.email}>
            {i.email}
          </span>
          <span className="shrink-0 text-caption text-faint">
            {i.role === WorkspaceRole.ADMIN ? t('role.admin') : t('role.member')}
            {i.expiresAt ? ` · ${t('mail.invite.until', { date: fmt.shortDate(timestampDate(i.expiresAt)) })}` : ''}
          </span>
          <IconButton label={`${t('mail.invite.revoke')}: ${i.email}`} className="text-muted hover:text-danger" onClick={() => revoke.mutate(i.id)}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      ))}
    </Card>
  );
}
