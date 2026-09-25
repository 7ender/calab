import { PresenceStatus, WorkspaceRole, type WorkspaceMember } from '@calaba/protocol';
import { useMemo, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { t, type MessageKey } from '../../i18n';
import { useWorkspaces } from '../../stores/workspaces';

export const ROLE_LABEL: Record<WorkspaceRole, MessageKey> = {
  [WorkspaceRole.UNSPECIFIED]: 'role.member',
  [WorkspaceRole.OWNER]: 'role.owner',
  [WorkspaceRole.ADMIN]: 'role.admin',
  [WorkspaceRole.MEMBER]: 'role.member',
  [WorkspaceRole.GUEST]: 'role.guest',
};

const online = (s: PresenceStatus | undefined): boolean =>
  s === PresenceStatus.ONLINE || s === PresenceStatus.IDLE || s === PresenceStatus.DND;

export function MembersPanel({ workspaceId }: { workspaceId: string }): ReactNode {
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const presences = useWorkspaces((s) => s.presences);
  const groups = useMemo(() => {
    const list = Object.values(members ?? {});
    const name = (m: WorkspaceMember): string => m.nickname || m.user?.displayName || '';
    list.sort((a, b) => a.role - b.role || name(a).localeCompare(name(b), 'ru'));
    return {
      on: list.filter((m) => online(presences[m.user?.id ?? '']?.status)),
      off: list.filter((m) => !online(presences[m.user?.id ?? '']?.status)),
    };
  }, [members, presences]);

  const row = (m: WorkspaceMember, dim: boolean): ReactNode => {
    const u = m.user;
    if (!u) return null;
    const name = m.nickname || u.displayName;
    return (
      <div key={u.id} className={dim ? 'flex items-center gap-2.5 rounded-md px-2 py-1.5 opacity-50' : 'flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover'}>
        <Avatar userId={u.id} name={name} fileId={u.avatarFileId || undefined} size={32} presence />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{name}</div>
          <div className="truncate text-[11px] text-faint">{u.statusText || (m.role <= WorkspaceRole.ADMIN ? t(ROLE_LABEL[m.role]) : '')}</div>
        </div>
      </div>
    );
  };

  return (
    <aside className="w-60 shrink-0 overflow-y-auto bg-side px-2 pb-4 pt-14" aria-label={t('shell.members')}>
      <h3 className="px-2 pb-1 text-[11px] font-bold uppercase tracking-wide text-faint">
        {t('members.online')} — {groups.on.length}
      </h3>
      {groups.on.map((m) => row(m, false))}
      <h3 className="px-2 pb-1 pt-4 text-[11px] font-bold uppercase tracking-wide text-faint">
        {t('members.offline')} — {groups.off.length}
      </h3>
      {groups.off.map((m) => row(m, true))}
    </aside>
  );
}
