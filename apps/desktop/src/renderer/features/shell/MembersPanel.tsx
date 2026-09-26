import * as Popover from '@radix-ui/react-popover';
import { WorkspaceRole, type WorkspaceMember } from '@calaba/protocol';
import { Crown, MonitorUp, Video, Volume2 } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { useRooms } from '../../stores/rooms';
import { useVoice } from '../../stores/voice';
import { isGuest, useWorkspaces } from '../../stores/workspaces';
import { GuestBadge, roleTextClass } from '../people/MemberBits';
import { MemberContextMenu } from '../people/MemberContextMenu';
import { groupMembers, nameOf } from '../people/members';
import { NicknameDialog } from '../people/NicknameDialog';
import { ProfileCard } from '../people/ProfileCard';

export const ROLE_LABEL: Record<WorkspaceRole, MessageKey> = {
  [WorkspaceRole.UNSPECIFIED]: 'role.member',
  [WorkspaceRole.OWNER]: 'role.owner',
  [WorkspaceRole.ADMIN]: 'role.admin',
  [WorkspaceRole.MEMBER]: 'role.member',
  [WorkspaceRole.GUEST]: 'role.guest',
};

/**
 * Members column (docs/09 #12): 240 px next to the chat from MEMBERS_COLUMN_MIN, a floating
 * panel below it (Esc closes it: services/hotkeys.ts). Groups «В сети» / «Не в сети», each ordered owner → admins →
 * members → guests: with a handful of built-in roles, role headers would mostly be groups of
 * one, so the role shows as the name colour (+ crown) instead — the Discord look without
 * the noise. Click → profile, right click → member menu.
 */
export function MembersPanel({ workspaceId, floating = false, drawer = false }: { workspaceId: string; floating?: boolean; drawer?: boolean }): ReactNode {
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const presences = useWorkspaces((s) => s.presences);
  const voice = useWorkspaces((s) => s.byId[workspaceId]?.voice);
  const groups = useMemo(() => groupMembers(Object.values(members ?? {}), presences, voice), [members, presences, voice]);
  const [profile, setProfile] = useState<string | null>(null);

  const section = (key: 'on' | 'off', title: string, list: WorkspaceMember[]): ReactNode =>
    list.length > 0 ? (
      <section aria-labelledby={`members-${key}`} className="mt-4 flex flex-col first:mt-0">
        <h3 id={`members-${key}`} className="px-2 pb-1 text-micro font-semibold uppercase tracking-wide text-faint">
          {title} — {list.length}
        </h3>
        <ul className="flex flex-col gap-px">
          {list.map((m) => (
            <li key={m.user?.id}>
              <MemberRow
                workspaceId={workspaceId}
                member={m}
                offline={key === 'off'}
                open={profile === m.user?.id}
                onOpenChange={(o) => setProfile(o ? (m.user?.id ?? null) : null)}
              />
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  return (
    <aside
      className={
        drawer
          ? // phone layout (ADR-0021): fills the right drawer (MobileShell)
            'min-h-0 flex-1 overflow-y-auto px-2 pb-[calc(var(--safe-bottom,0px)+16px)] pt-4'
          : floating
          ? 'mat-popover dense anim-in absolute bottom-[calc(var(--composer-height,64px)+8px)] right-3 top-[60px] z-[var(--z-popover)] w-60 overflow-y-auto rounded-[var(--radius-panel)] px-2 py-3'
          : 'mat-sidebar w-60 shrink-0 overflow-y-auto border-l border-line px-2 pb-4 pt-4'
      }
      aria-label={t('shell.members')}
    >
      {section('on', t('members.online'), groups.online)}
      {section('off', t('members.offline'), groups.offline)}
      {groups.online.length + groups.offline.length === 0 ? <p className="px-2 text-body text-muted">{t('people.empty')}</p> : null}
    </aside>
  );
}

/** One 42 px row; memoised so presence / speaking changes re-render only that row. */
const MemberRow = memo(function MemberRow({
  workspaceId,
  member: m,
  offline,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  member: WorkspaceMember;
  offline: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactNode {
  const u = m.user;
  const userId = u?.id ?? '';
  const v = useWorkspaces((s) => s.byId[workspaceId]?.voice[userId]);
  const roomName = useRooms((s) => (v?.roomId ? s.byId[v.roomId]?.name : undefined));
  const speaking = useVoice((s) => s.speaking[userId] ?? false);
  const [renaming, setRenaming] = useState(false);
  if (!u) return null;
  const name = nameOf(m);
  const statusLine = [u.statusEmoji, u.statusText].filter(Boolean).join(' ');

  // Second line: live voice activity first (it changes what you can do), then custom status.
  let second: ReactNode = null;
  if (v?.streaming)
    second = (
      <>
        <MonitorUp className="size-3.5 shrink-0 text-danger" aria-hidden />
        <span className="truncate">{t('people.streaming')}</span>
      </>
    );
  else if (v?.roomId)
    second = (
      <>
        <Volume2 className="size-3.5 shrink-0 text-ok" aria-hidden />
        <span className="truncate">{roomName ?? t('people.inVoice')}</span>
        {v.camera ? <Video className="size-3.5 shrink-0" aria-label={t('video.stateOn')} role="img" /> : null}
      </>
    );
  else if (statusLine) second = <span className="truncate">{statusLine}</span>;

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <MemberContextMenu workspaceId={workspaceId} userId={userId} onOpenProfile={() => onOpenChange(true)}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={t('people.openProfile', { name })}
            title={name}
            className={cx(
              'flex h-[42px] w-full items-center gap-3 rounded-[var(--radius-row)] px-2 text-left transition-colors duration-[var(--motion-fast)] hover:bg-hover',
              open && 'bg-active',
            )}
          >
            {/* Offline: grey, faded avatar + secondary text — never opacity on text (≥ 4.5:1). */}
            <span className={cx('flex shrink-0', offline && 'opacity-60 grayscale')}>
              <Avatar userId={userId} name={name} fileId={u.avatarFileId || undefined} size={32} presence speaking={speaking && !v?.muted} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1">
                <span className={cx('truncate text-body font-medium leading-[18px]', offline ? 'text-muted' : roleTextClass(m.role))}>{name}</span>
                {m.role === WorkspaceRole.OWNER ? (
                  <Crown className={cx('size-3.5 shrink-0', offline ? 'text-muted' : 'text-role-owner')} aria-label={t('people.owner')} role="img" />
                ) : null}
                {isGuest(m) ? <GuestBadge /> : null}
              </span>
              {second ? <span className="flex min-w-0 items-center gap-1 text-caption leading-4 text-muted">{second}</span> : null}
            </span>
          </button>
        </Popover.Trigger>
      </MemberContextMenu>
      <Popover.Portal>
        <Popover.Content
          side="left"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className="mat-popover dense anim-in z-[var(--z-popover)] rounded-[var(--radius-panel)] text-fg focus:outline-none"
          aria-label={name}
        >
          <ProfileCard
            workspaceId={workspaceId}
            userId={userId}
            onRename={() => {
              onOpenChange(false);
              setRenaming(true);
            }}
            onClose={() => onOpenChange(false)}
          />
        </Popover.Content>
      </Popover.Portal>
      {renaming ? <NicknameDialog workspaceId={workspaceId} userId={userId} onClose={() => setRenaming(false)} /> : null}
    </Popover.Root>
  );
});
