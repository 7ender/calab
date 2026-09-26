import * as ContextMenu from '@radix-ui/react-context-menu';
import { ArrowRightLeft, Check, ChevronRight, LogOut, MicOff, Pencil, UserCheck, UserMinus, UserRound, UserX, Volume2, VolumeX } from 'lucide-react';
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Slider, cx } from '../../components/ui';
import { t } from '../../i18n';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { roomsOfWorkspace, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, menuLabel, menuSeparator } from '../shell/menu';
import { disconnectFromVoice, moveMember, promoteGuest, removeMember, serverMute } from './actions';
import { hasAnyAction, memberActions, type MenuActions } from './members';
import { NicknameDialog } from './NicknameDialog';

/** What I may do with a member right now (reactive; the server re-checks every action). */
export function useMemberActions(workspaceId: string, userId: string): MenuActions | null {
  const meId = useSession((s) => s.me?.user?.id ?? '');
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const roomsById = useRooms((s) => s.byId);
  const myVoiceRoomId = useVoice((s) => s.roomId);
  return useMemo(() => {
    const target = entry?.members[userId];
    if (!entry || !target?.user) return null;
    return memberActions({
      meId,
      myRole: entry.role,
      target,
      targetVoice: entry.voice[userId],
      myVoiceRoomId,
      rooms: roomsOfWorkspace(roomsById, workspaceId),
      allowSelfNickname: entry.ws.allowSelfNickname,
    });
  }, [entry, userId, meId, myVoiceRoomId, roomsById, workspaceId]);
}

/**
 * Right-click menu of a workspace member (docs/09 #12, #32, #33, #35). Used by the members
 * column and the voice participants in the room list: wrap the row —
 *
 *   <MemberContextMenu workspaceId={ws} userId={id}><div>…row…</div></MemberContextMenu>
 *
 * The child must accept a ref and props (Radix `asChild`). Without any available action the
 * child is rendered as is. `onOpenProfile` adds a «Профиль» item.
 */
export function MemberContextMenu({
  workspaceId,
  userId,
  onOpenProfile,
  children,
}: {
  workspaceId: string;
  userId: string;
  onOpenProfile?: (() => void) | undefined;
  children: ReactElement;
}): ReactNode {
  const actions = useMemberActions(workspaceId, userId);
  const [renaming, setRenaming] = useState(false);
  const dialog = renaming ? <NicknameDialog workspaceId={workspaceId} userId={userId} onClose={() => setRenaming(false)} /> : null;
  if (!actions || (!hasAnyAction(actions) && !onOpenProfile)) return children;
  return (
    <>
      <ContextMenu.Root modal={false}>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <MemberMenuContent workspaceId={workspaceId} userId={userId} actions={actions} onRename={() => setRenaming(true)} onOpenProfile={onOpenProfile} />
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {dialog}
    </>
  );
}

function MemberMenuContent({
  workspaceId,
  userId,
  actions: a,
  onRename,
  onOpenProfile,
}: {
  workspaceId: string;
  userId: string;
  actions: MenuActions;
  onRename: () => void;
  onOpenProfile: (() => void) | undefined;
}): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const self = useSession((s) => s.me?.user?.id) === userId;
  const roomId = useWorkspaces((s) => s.byId[workspaceId]?.voice[userId]?.roomId ?? '');
  const localMuted = usePrefs((s) => !!s.mutedUsers[userId]);
  const voiceBlock = a.volume || (a.serverMute && !a.alreadyMuted) || a.disconnect || a.moveTargets.length > 0;
  const adminBlock = a.promote || a.removeGuest || a.kick;
  return (
    <ContextMenu.Content className={cx(menuBox, 'w-72')} collisionPadding={8}>
      <div className={cx(menuLabel, 'truncate')} title={name}>
        {name}
      </div>
      {onOpenProfile ? (
        <ContextMenu.Item className={menuItem} onSelect={onOpenProfile}>
          <UserRound className="size-4" aria-hidden /> {t('people.menu.profile')}
        </ContextMenu.Item>
      ) : null}
      {a.rename ? (
        <ContextMenu.Item className={menuItem} onSelect={onRename}>
          <Pencil className="size-4" aria-hidden /> {self ? t('people.menu.renameSelf') : t('people.menu.rename')}
        </ContextMenu.Item>
      ) : null}
      {voiceBlock ? <ContextMenu.Separator className={menuSeparator} /> : null}
      {a.volume ? (
        <>
          <VolumeRow userId={userId} />
          <ContextMenu.CheckboxItem className={menuItem} checked={localMuted} onCheckedChange={(v) => voice.setUserMuted(userId, v)}>
            <span className="grid w-4 place-items-center">
              <ContextMenu.ItemIndicator>
                <Check className="size-4" aria-hidden />
              </ContextMenu.ItemIndicator>
            </span>
            {t('people.menu.localMute')}
          </ContextMenu.CheckboxItem>
        </>
      ) : null}
      {/* Moderation items appear only with the right; «already muted» is shown on the row itself. */}
      {a.serverMute && !a.alreadyMuted ? (
        <ContextMenu.Item className={menuItem} onSelect={() => serverMute(roomId, userId)}>
          <MicOff className="size-4" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t('people.menu.serverMute')}</span>
        </ContextMenu.Item>
      ) : null}
      {a.moveTargets.length > 0 ? (
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger className={cx(menuItem, 'data-[state=open]:bg-hover')}>
            <ArrowRightLeft className="size-4" aria-hidden />
            <span className="flex-1">{t('people.menu.move')}</span>
            <ChevronRight className="size-4" aria-hidden />
          </ContextMenu.SubTrigger>
          <ContextMenu.Portal>
            <ContextMenu.SubContent className={cx(menuBox, 'max-h-80 w-56 overflow-y-auto')} sideOffset={4} collisionPadding={8}>
              {a.moveTargets.map((r) => (
                <ContextMenu.Item key={r.id} className={menuItem} onSelect={() => moveMember(workspaceId, roomId, userId, r.id)}>
                  <Volume2 className="size-4 shrink-0" aria-hidden />
                  <span className="truncate" title={r.name}>
                    {r.name}
                  </span>
                </ContextMenu.Item>
              ))}
            </ContextMenu.SubContent>
          </ContextMenu.Portal>
        </ContextMenu.Sub>
      ) : null}
      {a.disconnect ? (
        <ContextMenu.Item className={menuItem} onSelect={() => disconnectFromVoice(roomId, userId)}>
          <LogOut className="size-4" aria-hidden /> {t('people.menu.disconnect')}
        </ContextMenu.Item>
      ) : null}
      {adminBlock ? <ContextMenu.Separator className={menuSeparator} /> : null}
      {a.promote ? (
        <ContextMenu.Item className={menuItem} onSelect={() => promoteGuest(workspaceId, userId)}>
          <UserCheck className="size-4" aria-hidden /> {t('people.menu.promote')}
        </ContextMenu.Item>
      ) : null}
      {a.removeGuest ? (
        <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void removeMember(workspaceId, userId, true)}>
          <UserMinus className="size-4" aria-hidden /> {t('people.menu.removeGuest')}
        </ContextMenu.Item>
      ) : null}
      {a.kick ? (
        <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void removeMember(workspaceId, userId, false)}>
          <UserX className="size-4" aria-hidden /> {t('people.menu.kick')}
        </ContextMenu.Item>
      ) : null}
    </ContextMenu.Content>
  );
}

/**
 * Per-user playback volume («Громкость», 0–100 %; element.volume caps at 1 — no WebAudio boost,
 * docs/02 echo rules). Shared by the member menu and the profile card.
 */
export function VolumeRow({ userId, className }: { userId: string; className?: string }): ReactNode {
  const volume = usePrefs((s) => s.userVolumes[userId] ?? 1);
  const muted = usePrefs((s) => !!s.mutedUsers[userId]);
  return (
    // Not a menu item: a slider row (arrow keys adjust it once focused with Tab).
    <div className={cx('px-2 pb-2 pt-1', className)}>
      <div className="mb-1 flex items-center justify-between text-caption text-muted">
        <span className="flex items-center gap-1.5">
          {muted ? <VolumeX className="size-3.5" aria-hidden /> : <Volume2 className="size-3.5" aria-hidden />} {t('people.menu.volume')}
        </span>
        <span className="tabular-nums">{muted ? t('people.menu.localMuted') : `${Math.round(volume * 100)}%`}</span>
      </div>
      <Slider label={t('people.menu.volume')} value={volume} min={0} max={1} step={0.01} onChange={(v) => voice.setUserVolume(userId, v)} />
    </div>
  );
}
