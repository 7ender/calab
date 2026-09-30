import { RoomType, WorkspaceRole } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { PickerPanel } from '../../components/picker/Picker';
import type { PickerGroup } from '../../components/picker/pickerModel';
import { Button, Input, Modal, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { log } from '../../lib/log';
import { sendDmText } from '../../services/dms';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useWorkspaces } from '../../stores/workspaces';
import { roomLabel } from '../chat/roomLabel';
import { MemberPickRow } from './MemberPicker';
import { memberItems, type MemberPickItem } from './memberPickItems';
import { RoomGuestInviteCard, useGuestInviteShown } from './RoomGuestInviteCard';
import { roomInviteLink, roomLinkError } from './roomLink';

/**
 * «Пригласить в комнату» (docs/09 #33, #48): the member picker of the room's workspace — picking
 * someone sends them the room link in a DM (they may be anywhere in the app); below, the link
 * itself to copy. Guests have no DMs (ADR-0020) and are left out; people already in the voice
 * room are shown, not choosable. Opened with INVITE_GUESTS or INVITE_MEMBERS in the room (ADR-0043):
 * with INVITE_MEMBERS alone the link handed out is a members-only one.
 */
export function InviteToRoomDialog({ roomId, onClose }: { roomId: string; onClose: () => void }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const wsId = room?.workspaceId ?? '';
  const members = useWorkspaces((s) => s.byId[wsId]?.members);
  const voice = useWorkspaces((s) => s.byId[wsId]?.voice);
  const meId = useSession((s) => s.me?.user?.id ?? '');
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const [sending, setSending] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // docs/09 #55: with the right to create room links the guest-link card leads the dialog and is
  // the link to copy — no second field below, and no link minted just by opening the dialog.
  const guestCard = useGuestInviteShown(roomId);
  const membersOnly = !guestCard;
  const link = useQuery({ queryKey: ['roomInviteLink', roomId], queryFn: () => roomInviteLink(roomId, membersOnly), retry: false, staleTime: 60_000, enabled: !guestCard });

  const groups = useMemo((): Array<PickerGroup<MemberPickItem>> => {
    const list = Object.values(members ?? {}).filter((m) => m.user && m.user.id !== meId && m.role !== WorkspaceRole.GUEST && !m.user.isGuest);
    const items = memberItems(list, {
      decorate: (m) => (room?.type === RoomType.VOICE && voice?.[m.user?.id ?? '']?.roomId === roomId ? { note: t('roomInvite.inRoom'), disabled: true } : undefined),
    });
    return [{ id: 'members', label: t('picker.members'), items }];
  }, [members, voice, meId, room?.type, roomId]);

  if (!room) return null;
  const name = roomLabel(room);

  const invite = async (item: MemberPickItem): Promise<void> => {
    if (sending || sent.has(item.userId)) return;
    setSending(item.userId);
    try {
      const url = link.data ?? (await roomInviteLink(roomId, membersOnly));
      await sendDmText(item.userId, t('roomInvite.dmText', { room: name, link: url }));
      setSent((s) => new Set(s).add(item.userId));
    } catch (e) {
      log.warn('room invite dm failed', e);
      toast.error(t('roomInvite.failed'));
    } finally {
      setSending(null);
    }
  };

  const copy = (): void => {
    if (!link.data) return;
    void navigator.clipboard.writeText(link.data).then(
      () => toast.success(t('people.link.copied')),
      () => toast.error(t('roomInvite.failed')),
    );
  };

  return (
    <Modal open onClose={onClose} title={t('roomInvite.title', { room: name })} description={t('roomInvite.hint')} initialFocus={input} fill>
      <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="room-invite">
        {guestCard ? (
          <div className="shrink-0">
            <RoomGuestInviteCard roomId={roomId} />
          </div>
        ) : null}
        <div className="-mx-2 flex min-h-0 flex-1 flex-col">
          <PickerPanel<MemberPickItem>
            groups={groups}
            onSelect={(item) => void invite(item)}
            placeholder={t('picker.searchPeople')}
            label={t('roomInvite.title', { room: name })}
            height={256}
            fill
            inputRef={input}
            autoFocus={false}
            renderItem={(item, active) => (
              <MemberPickRow
                item={item}
                active={active}
                trailing={
                  sending === item.userId ? (
                    <Spinner className={cx('size-4', active && 'text-accent-fg')} />
                  ) : sent.has(item.userId) ? (
                    <span className={cx('flex shrink-0 items-center gap-1 text-caption', active ? '' : 'text-ok')}>
                      <Check className="size-3.5" aria-hidden /> {t('roomInvite.sent')}
                    </span>
                  ) : item.disabled ? null : (
                    <span
                      aria-hidden
                      className={cx(
                        'shrink-0 rounded-[var(--radius-control)] px-2 py-0.5 text-caption font-medium',
                        active ? 'bg-[color-mix(in_srgb,black_20%,transparent)]' : 'border border-line text-fg',
                      )}
                    >
                      {t('roomInvite.send')}
                    </span>
                  )
                }
              />
            )}
          />
        </div>
        {guestCard ? null : (
          <div className="flex shrink-0 flex-col gap-1.5">
            <span className="text-caption font-medium text-muted">{t('roomInvite.link')}</span>
            <div className="flex items-center gap-2">
              <Input readOnly value={link.data ?? ''} placeholder={link.isError ? roomLinkError(link.error) : '…'} aria-label={t('roomInvite.link')} className="min-w-0 flex-1" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="secondary" disabled={!link.data} onClick={copy}>
                {t('roomInvite.copy')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
