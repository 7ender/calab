import { timestampDate } from '@bufbuild/protobuf/wkt';
import { PERMISSION_BITS, WorkspaceRole, type Room } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { Timer } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, Card, Empty, Row, Spinner, Toggle } from '../../components/ui';
import { plural, t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { fmt } from '../../lib/format';
import { useArchiveView } from '../../stores/archiveView';
import { toast } from '../../stores/toasts';
import { memberName, useWorkspaces } from '../../stores/workspaces';

const { CREATE_TEMP_ROOMS } = PERMISSION_BITS;

export const tempArchiveKey = (workspaceId: string): readonly unknown[] => ['tempArchive', workspaceId];

/**
 * Workspace settings → «Общие», temporary rooms (ADR-0044): «могут создавать все участники» — the
 * CREATE_TEMP_ROOMS bit of the built-in Member role (MANAGE_ROLES; other roles in the role
 * editor), and «Архив» — closed temporary rooms (MANAGE_ROOM) with «Открыть историю» (read-only
 * chat, stores/archiveView).
 */
export function TempRoomsCards({ workspaceId, manageRoles, manageRooms }: { workspaceId: string; manageRoles: boolean; manageRooms: boolean }): ReactNode {
  return (
    <>
      {manageRoles ? <AllowCard workspaceId={workspaceId} /> : null}
      {manageRooms ? <ArchiveCard workspaceId={workspaceId} /> : null}
    </>
  );
}

function AllowCard({ workspaceId }: { workspaceId: string }): ReactNode {
  const role = useWorkspaces((s) => s.byId[workspaceId]?.roles.find((r) => r.builtin === WorkspaceRole.MEMBER));
  const [busy, setBusy] = useState(false);
  if (!role) return null;
  const on = (role.permissions & CREATE_TEMP_ROOMS) !== 0n;
  const set = async (v: boolean): Promise<void> => {
    setBusy(true);
    try {
      const permissions = v ? role.permissions | CREATE_TEMP_ROOMS : role.permissions & ~CREATE_TEMP_ROOMS;
      const r = await api.roles.update(workspaceId, role.id, { permissions });
      if (r.role) useWorkspaces.getState().upsertRole(r.role);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <Row label={t('temp.allowAll')} hint={t('temp.allowAllHint')}>
        <Toggle label={t('temp.allowAll')} checked={on} disabled={busy} onChange={(v) => void set(v)} />
      </Row>
    </Card>
  );
}

function ArchiveCard({ workspaceId }: { workspaceId: string }): ReactNode {
  const q = useQuery({ queryKey: tempArchiveKey(workspaceId), queryFn: ({ signal }) => api.rooms.archived(workspaceId, signal) });
  // Only temporary rooms: permanent archived rooms are not readable (404, ADR-0044 «Архив»).
  const rooms = (q.data?.rooms ?? []).filter((r) => !!r.expiresAt);
  let body: ReactNode;
  if (q.isLoading) body = <div className="grid place-items-center py-4"><Spinner /></div>;
  else if (q.isError) body = <Empty>{errorText(q.error)}</Empty>;
  else if (rooms.length === 0) body = <div className="px-3 py-3 text-body text-muted">{t('temp.archiveEmpty')}</div>;
  else body = rooms.map((r) => <ArchiveRow key={r.id} workspaceId={workspaceId} room={r} />);
  return (
    <Card title={t('temp.archive')} footer={t('temp.archiveHint')}>
      <div data-testid="temp-archive">{body}</div>
    </Card>
  );
}

function ArchiveRow({ workspaceId, room }: { workspaceId: string; room: Room }): ReactNode {
  const creator = useWorkspaces(() => (room.createdBy ? memberName(workspaceId, room.createdBy) : '—'));
  const closed = room.archivedAt ?? room.expiresAt;
  const when = closed ? fmt.stamp(timestampDate(closed)) : '—';
  return (
    <div className="flex min-h-12 items-center gap-3 px-3 py-2" data-testid="temp-archive-row">
      <Timer className="size-5 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-medium" title={room.name}>
          {room.name}
        </div>
        <div className="truncate text-caption text-faint">
          {t('temp.archiveMeta', { creator, when })} · {plural('temp.archiveMessages', room.messageCount)}
        </div>
      </div>
      <Button size="sm" variant="secondary" onClick={() => useArchiveView.getState().open(room)}>
        {t('temp.openHistory')}
      </Button>
    </div>
  );
}
