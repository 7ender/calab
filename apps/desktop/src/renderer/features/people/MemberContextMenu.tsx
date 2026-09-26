import * as ContextMenu from '@radix-ui/react-context-menu';
import { WorkspaceRole } from '@calaba/protocol';
import { ArrowRightLeft, AtSign, MessageCircle, Check, ChevronRight, IdCard, LogOut, Pencil, Shield, UserCheck, UserMinus, UserRound, UserX, VideoOff, Volume2, VolumeX } from 'lucide-react';
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
import { copyUserId, disconnectFromVoice, moveMember, promoteGuest, removeMember, serverMute, serverUnmute, setMemberRole, stopMemberCamera } from './actions';
import { requestMention } from '../chat/mentionRequest';
import { hasAnyAction, memberActions, type MenuActions } from './members';
import { NicknameDialog } from './NicknameDialog';
import { useCanDm } from '../dm/canDm';
import { startDm } from '../../services/dms';

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
  const canDm = useCanDm(workspaceId, userId);
  const [renaming, setRenaming] = useState(false);
  const dialog = renaming ? <NicknameDialog workspaceId={workspaceId} userId={userId} onClose={() => setRenaming(false)} /> : null;
  if (!actions || (!hasAnyAction(actions) && !onOpenProfile && !canDm)) return children;
  return (
    <>
      <ContextMenu.Root modal={false}>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <MemberMenuContent workspaceId={workspaceId} userId={userId} actions={actions} canDm={canDm} onRename={() => setRenaming(true)} onOpenProfile={onOpenProfile} />
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {dialog}
    </>
  );
}

/** 40 px rows (Discord member menu), 15 px text. */
const row = cx(menuItem, 'h-10 text-[15px]');
const danger = 'text-danger-text data-[highlighted]:text-accent-fg';

/** Right-aligned 20 px rounded checkbox (Discord); the item's checked state fills it. */
function MenuCheck({
  label,
  checked,
  onChange,
  disabled,
  tone,
  title,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  tone?: 'danger';
  title?: string;
  testId?: string;
}): ReactNode {
  return (
    <ContextMenu.CheckboxItem
      className={cx(row, 'group/check justify-between', tone === 'danger' && danger)}
      checked={checked}
      disabled={disabled}
      title={title}
      data-testid={testId}
      onCheckedChange={onChange}
      // A checkbox toggles in place (Discord): the menu stays open.
      onSelect={(e) => e.preventDefault()}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center rounded-[5px] border-[1.5px] border-[var(--color-label-tertiary)] group-data-[state=checked]/check:border-accent-strong group-data-[state=checked]/check:bg-accent-strong group-data-[highlighted]/check:border-current"
      >
        <ContextMenu.ItemIndicator>
          <Check className="size-3.5 text-white" strokeWidth={3} />
        </ContextMenu.ItemIndicator>
      </span>
    </ContextMenu.CheckboxItem>
  );
}

function MemberMenuContent({
  workspaceId,
  userId,
  actions: a,
  canDm,
  onRename,
  onOpenProfile,
}: {
  workspaceId: string;
  userId: string;
  actions: MenuActions;
  canDm: boolean;
  onRename: () => void;
  onOpenProfile: (() => void) | undefined;
}): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const self = useSession((s) => s.me?.user?.id) === userId;
  const roomId = useWorkspaces((s) => s.byId[workspaceId]?.voice[userId]?.roomId ?? '');
  const role = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]?.role);
  const localMuted = usePrefs((s) => !!s.mutedUsers[userId]);
  const localDeaf = usePrefs((s) => !!s.deafUsers[userId]);
  const videoHidden = usePrefs((s) => !!s.hiddenVideo[userId]);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const hiddenVideo = usePrefs((s) => s.hiddenVideo);
  const personal = a.volume || a.hideVideo || a.rename || a.roles !== null || a.moveTargets.length > 0;
  const moderation = a.serverMute || a.serverUnmute || a.stopCamera || a.disconnect;
  const admin = a.promote || a.removeGuest || a.kick;
  const setHidden = (on: boolean): void => {
    const next = { ...hiddenVideo };
    if (on) next[userId] = true;
    else delete next[userId];
    setPrefs({ hiddenVideo: next });
  };
  return (
    // Discord layout: sections split by hairlines — profile | for me | moderation (red) | admin | ID.
    <ContextMenu.Content className={cx(menuBox, 'w-[300px]')} collisionPadding={8}>
      <div className={cx(menuLabel, 'truncate')} title={name}>
        {name}
      </div>
      {onOpenProfile ? (
        <ContextMenu.Item className={row} onSelect={onOpenProfile}>
          <UserRound className="size-4" aria-hidden /> {t('people.menu.profile')}
        </ContextMenu.Item>
      ) : null}
      {canDm ? (
        <ContextMenu.Item className={row} onSelect={() => void startDm(userId)}>
          <MessageCircle className="size-4" aria-hidden /> {t('dm.write')}
        </ContextMenu.Item>
      ) : null}
      <ContextMenu.Item className={row} onSelect={() => requestMention(userId, name)}>
        <AtSign className="size-4" aria-hidden /> {t('people.menu.mention')}
      </ContextMenu.Item>

      {personal ? <ContextMenu.Separator className={menuSeparator} /> : null}
      {a.volume ? (
        <>
          <VolumeRow userId={userId} menu />
          <MenuCheck label={t('people.menu.localMute')} checked={localMuted} onChange={(v) => voice.setUserMuted(userId, v)} />
          <MenuCheck label={t('people.menu.deafen')} title={t('people.menu.deafenHint')} checked={localDeaf} onChange={(v) => voice.setUserDeaf(userId, v)} />
        </>
      ) : null}
      {/* Local: stop receiving their camera (unsubscribe), an avatar tile instead (docs/09 #42). */}
      {a.hideVideo ? <MenuCheck label={t('video.hide')} checked={videoHidden} onChange={setHidden} /> : null}
      {a.rename ? (
        <ContextMenu.Item className={row} onSelect={onRename}>
          <Pencil className="size-4" aria-hidden /> {self ? t('people.menu.renameSelf') : t('people.menu.rename')}
        </ContextMenu.Item>
      ) : null}
      {a.roles ? (
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger className={cx(row, 'data-[state=open]:not-data-[highlighted]:bg-hover')}>
            <Shield className="size-4" aria-hidden />
            <span className="flex-1">{t('people.menu.roles')}</span>
            <ChevronRight className="size-4" aria-hidden />
          </ContextMenu.SubTrigger>
          <ContextMenu.Portal>
            <ContextMenu.SubContent className={cx(menuBox, 'w-56')} sideOffset={4} collisionPadding={8}>
              <ContextMenu.RadioGroup value={String(role ?? '')} onValueChange={(v) => setMemberRole(workspaceId, userId, Number(v))}>
                {[
                  { r: WorkspaceRole.ADMIN, key: 'role.admin' as const, ok: a.roles.admin },
                  { r: WorkspaceRole.MEMBER, key: 'role.member' as const, ok: a.roles.member },
                ].map((o) => (
                  <ContextMenu.RadioItem key={o.r} value={String(o.r)} disabled={!o.ok} className={row}>
                    <span className="grid w-4 place-items-center">
                      <ContextMenu.ItemIndicator>
                        <Check className="size-4" aria-hidden />
                      </ContextMenu.ItemIndicator>
                    </span>
                    {t(o.key)}
                  </ContextMenu.RadioItem>
                ))}
              </ContextMenu.RadioGroup>
            </ContextMenu.SubContent>
          </ContextMenu.Portal>
        </ContextMenu.Sub>
      ) : null}
      {a.moveTargets.length > 0 ? (
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger className={cx(row, 'data-[state=open]:not-data-[highlighted]:bg-hover')}>
            <ArrowRightLeft className="size-4" aria-hidden />
            <span className="flex-1">{t('people.menu.move')}</span>
            <ChevronRight className="size-4" aria-hidden />
          </ContextMenu.SubTrigger>
          <ContextMenu.Portal>
            <ContextMenu.SubContent className={cx(menuBox, 'max-h-80 w-56 overflow-y-auto')} sideOffset={4} collisionPadding={8}>
              {a.moveTargets.map((r) => (
                <ContextMenu.Item key={r.id} className={row} onSelect={() => moveMember(workspaceId, roomId, userId, r.id)}>
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

      {/* Moderation (by rights, red like Discord's «Server Mute»). */}
      {moderation ? <ContextMenu.Separator className={menuSeparator} /> : null}
      {a.serverMute || a.serverUnmute ? (
        <MenuCheck
          label={t('people.menu.serverMuteToggle')}
          tone="danger"
          checked={a.alreadyMuted}
          disabled={a.alreadyMuted ? !a.serverUnmute : !a.serverMute}
          onChange={(v) => (v ? serverMute(roomId, userId) : serverUnmute(roomId, userId))}
          testId="menu-server-mute"
        />
      ) : null}
      {a.stopCamera ? (
        <ContextMenu.Item className={cx(row, danger)} onSelect={() => stopMemberCamera(workspaceId, roomId, userId)}>
          <VideoOff className="size-4" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t('video.stopMember')}</span>
        </ContextMenu.Item>
      ) : null}
      {a.disconnect ? (
        <ContextMenu.Item className={cx(row, danger)} onSelect={() => disconnectFromVoice(roomId, userId)}>
          <LogOut className="size-4" aria-hidden /> {t('people.menu.disconnect')}
        </ContextMenu.Item>
      ) : null}

      {admin ? <ContextMenu.Separator className={menuSeparator} /> : null}
      {a.promote ? (
        <ContextMenu.Item className={row} onSelect={() => promoteGuest(workspaceId, userId)}>
          <UserCheck className="size-4" aria-hidden /> {t('people.menu.promote')}
        </ContextMenu.Item>
      ) : null}
      {a.removeGuest ? (
        <ContextMenu.Item className={cx(row, danger)} onSelect={() => void removeMember(workspaceId, userId, true)}>
          <UserMinus className="size-4" aria-hidden /> {t('people.menu.removeGuest')}
        </ContextMenu.Item>
      ) : null}
      {a.kick ? (
        <ContextMenu.Item className={cx(row, danger)} onSelect={() => void removeMember(workspaceId, userId, false)}>
          <UserX className="size-4" aria-hidden /> {t('people.menu.kick')}
        </ContextMenu.Item>
      ) : null}

      <ContextMenu.Separator className={menuSeparator} />
      <ContextMenu.Item className={row} onSelect={() => copyUserId(userId)}>
        <IdCard className="size-4" aria-hidden /> {t('people.menu.copyId')}
      </ContextMenu.Item>
    </ContextMenu.Content>
  );
}

/**
 * Per-user playback volume («Громкость», 0–100 %; element.volume caps at 1 — no WebAudio boost,
 * docs/02 echo rules). Shared by the member menu and the profile card.
 */
export function VolumeRow({ userId, className, menu = false }: { userId: string; className?: string; menu?: boolean }): ReactNode {
  const volume = usePrefs((s) => s.userVolumes[userId] ?? 1);
  const muted = usePrefs((s) => !!s.mutedUsers[userId]);
  const value = muted ? t('people.menu.localMuted') : `${Math.round(volume * 100)}%`;
  const body = (
    <>
      <div className="mb-1 flex items-center justify-between text-caption text-muted">
        <span className="flex items-center gap-1.5">
          {muted ? <VolumeX className="size-3.5" aria-hidden /> : <Volume2 className="size-3.5" aria-hidden />} {t('people.menu.volume')}
        </span>
        <span className="tabular-nums">{value}</span>
      </div>
      <Slider label={t('people.menu.volume')} value={volume} min={0} max={1} step={0.01} pointerOnly={menu} onChange={(v) => voice.setUserVolume(userId, v)} />
    </>
  );
  if (!menu) return <div className={cx('px-2 pb-2 pt-1', className)}>{body}</div>;
  // In a menu only menu items are allowed (axe aria-required-children), so the row is one: ↑/↓
  // reach it like any item, ←/→ change the volume by 5 %, the mouse drags the slider; selecting
  // it keeps the menu open.
  return (
    <ContextMenu.Item
      className={cx('rounded-[5px] px-2 pb-2 pt-1 outline-none data-[highlighted]:bg-hover', className)}
      aria-label={`${t('people.menu.volume')}: ${value}`}
      onSelect={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const next = Math.min(1, Math.max(0, Math.round((volume + (e.key === 'ArrowRight' ? 0.05 : -0.05)) * 100) / 100));
        voice.setUserVolume(userId, next);
      }}
    >
      {body}
    </ContextMenu.Item>
  );
}
