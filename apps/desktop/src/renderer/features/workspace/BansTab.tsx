import type { WorkspaceBan } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Empty, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { fmt } from '../../lib/format';
import { toast } from '../../stores/toasts';
import { memberName } from '../../stores/workspaces';
import { bansKey } from '../../lib/moderation';

/**
 * Workspace settings → «Забаненные» (docs/09 #32; owner / admins): who is banned, why, when and
 * by whom, and «Разбанить» (the user can then be invited again; the membership is not restored).
 */
export function BansTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: bansKey(workspaceId),
    queryFn: ({ signal }) => api.workspaces.bans(workspaceId, signal),
  });
  const unban = useMutation({
    mutationFn: (userId: string) => api.workspaces.unban(workspaceId, userId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: bansKey(workspaceId) }),
    onError: (e) => toast.error(errorText(e)),
  });
  const bans = q.data?.bans ?? [];
  const ask = async (b: WorkspaceBan): Promise<void> => {
    const name = b.user?.displayName ?? '';
    if (await confirmAction(t('bans.unban'), t('bans.unbanText', { name }), t('bans.unban'), 'primary')) unban.mutate(b.user?.id ?? '');
  };
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Empty>{errorText(q.error)}</Empty>;
  if (bans.length === 0) return <Empty>{t('bans.none')}</Empty>;
  return (
    <Card title={t('bans.card', { n: bans.length })} footer={t('bans.hint')}>
      {bans.map((b) => {
        const u = b.user;
        if (!u) return null;
        const by = b.bannedBy ? memberName(workspaceId, b.bannedBy) : '—';
        const when = b.createdAt ? fmt.shortDate(timestampDate(b.createdAt)) : '—';
        return (
          <div key={u.id} className="flex min-h-12 items-center gap-3 px-3 py-2" data-testid="ws-ban-row">
            <Avatar userId={u.id} name={u.displayName} fileId={u.avatarFileId || undefined} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-body font-medium" title={b.email || undefined}>
                {u.displayName}
              </div>
              <div className="truncate text-caption text-faint" title={b.reason || undefined}>
                {b.reason || t('bans.noReason')} · {t('bans.meta', { when, who: by })}
              </div>
            </div>
            <Button size="sm" variant="secondary" aria-label={t('bans.unbanFor', { name: u.displayName })} onClick={() => void ask(b)}>
              {t('bans.unban')}
            </Button>
          </div>
        );
      })}
    </Card>
  );
}
