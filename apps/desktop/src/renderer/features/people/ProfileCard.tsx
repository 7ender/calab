import { PresenceStatus, WorkspaceRole } from '@calaba/protocol';
import { useTimeZoneLabel } from '../../services/timezone';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { MessageCircle, MonitorUp, Pencil, Volume2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button, Toggle } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { isGuest, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { GuestBadge, RoleIcon, roleTextClass } from './MemberBits';
import { VolumeRow, useMemberActions } from './MemberContextMenu';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useCanDm } from '../dm/canDm';
import { startDm } from '../../services/dms';

const ROLE_KEY: Record<WorkspaceRole, MessageKey> = {
  [WorkspaceRole.UNSPECIFIED]: 'role.member',
  [WorkspaceRole.OWNER]: 'role.owner',
  [WorkspaceRole.ADMIN]: 'role.admin',
  [WorkspaceRole.MEMBER]: 'role.member',
  [WorkspaceRole.GUEST]: 'role.guest',
};

const PRESENCE_KEY: Partial<Record<PresenceStatus, MessageKey>> = {
  [PresenceStatus.ONLINE]: 'presence.online',
  [PresenceStatus.IDLE]: 'presence.idle',
  [PresenceStatus.DND]: 'presence.dnd',
};

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Member profile (docs/09 #12): avatar, name (nickname) + profile name, presence, custom
 * status, role, voice, «В пространстве с», and «Сменить ник» when allowed.
 */
export function ProfileCard({
  workspaceId,
  userId,
  onRename,
  onClose,
}: {
  workspaceId: string;
  userId: string;
  onRename: () => void;
  /** Closes the card (after «Написать» opened the DM). */
  onClose?: () => void;
}): ReactNode {
  const m = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]);
  const status = useWorkspaces((s) => s.presences[userId]?.status);
  const v = useWorkspaces((s) => s.byId[workspaceId]?.voice[userId]);
  const roomName = useRooms((s) => (v?.roomId ? s.byId[v.roomId]?.name : undefined));
  const self = useSession((s) => s.me?.user?.id) === userId;
  const name = useMemberName(workspaceId, userId);
  const tz = useTimeZoneLabel(userId);
  const actions = useMemberActions(workspaceId, userId);
  const localMuted = usePrefs((s) => !!s.mutedUsers[userId]);
  const canDm = useCanDm(workspaceId, userId);
  const u = m?.user;
  if (!m || !u) return null;
  const presence = status !== undefined ? PRESENCE_KEY[status] : undefined;
  const statusLine = [u.statusEmoji, u.statusText].filter(Boolean).join(' ');
  return (
    <div className="flex w-72 flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <Avatar userId={u.id} name={name} fileId={u.avatarFileId || undefined} size={56} presence className="[&>span:last-child]:border-[var(--color-popover-solid)]" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h3 className={`truncate text-headline font-semibold ${roleTextClass(m.role)}`} title={name}>
              {name}
              {tz ? <span className="font-normal text-muted"> {tz}</span> : null}
            </h3>
            {isGuest(m) ? <GuestBadge /> : null}
          </div>
          {m.nickname && m.nickname !== u.displayName ? (
            <div className="truncate text-body text-muted" title={u.displayName}>
              {u.displayName}
            </div>
          ) : null}
          <div className="text-caption text-muted">{t(presence ?? 'members.offline')}</div>
        </div>
      </div>
      {statusLine ? <p className="selectable break-words text-body">{statusLine}</p> : null}
      {canDm ? (
        // ADR-0020: the most direct next step from a profile.
        <Button
          className="w-full"
          onClick={() => {
            onClose?.();
            void startDm(userId);
          }}
        >
          <MessageCircle className="size-3.5" aria-hidden />
          {t('dm.write')}
        </Button>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 border-t border-line pt-3 text-caption">
        <dt className="text-muted">{t('people.profile.role')}</dt>
        <dd className="flex min-w-0 items-center gap-1.5">
          <RoleIcon role={m.role} />
          {t(ROLE_KEY[m.role])}
        </dd>
        {v?.roomId ? (
          <>
            <dt className="text-muted">{t('people.profile.voice')}</dt>
            <dd className="flex min-w-0 items-center gap-1.5">
              {v.streaming ? <MonitorUp className="size-3.5 shrink-0 text-danger" aria-hidden /> : <Volume2 className="size-3.5 shrink-0 text-ok" aria-hidden />}
              <span className="truncate" title={roomName}>
                {v.streaming ? `${t('people.streaming')} · ` : ''}
                {roomName ?? t('people.inVoice')}
              </span>
            </dd>
          </>
        ) : null}
        {m.joinedAt ? (
          <>
            <dt className="text-muted">{t('people.profile.joined')}</dt>
            <dd>{dateFmt.format(timestampDate(m.joinedAt))}</dd>
          </>
        ) : null}
      </dl>
      {actions?.volume ? (
        // Discord's most-used member actions: volume and «mute for me» (docs/09 #12).
        <div className="-mx-2 flex flex-col border-t border-line pt-2">
          <VolumeRow userId={userId} />
          <label className="flex h-8 items-center justify-between gap-3 px-2 text-body">
            <span>{t('people.menu.localMute')}</span>
            <Toggle checked={localMuted} onChange={(v) => voice.setUserMuted(userId, v)} label={t('people.menu.localMute')} />
          </label>
        </div>
      ) : null}
      {actions?.rename ? (
        <Button variant="secondary" className="w-full" onClick={onRename}>
          <Pencil className="size-3.5" aria-hidden />
          {self ? t('people.menu.renameSelf') : t('people.menu.rename')}
        </Button>
      ) : null}
    </div>
  );
}
