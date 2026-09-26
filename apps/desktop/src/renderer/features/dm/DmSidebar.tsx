import * as ContextMenu from '@radix-ui/react-context-menu';
import { MessageCirclePlus, Search, Plus } from 'lucide-react';
import { memo, useEffect, useMemo, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { fmtTime } from '../../lib/format';
import { loadDmPreviews, openDm } from '../../services/dms';
import { shareOrigin } from '../../services/links';
import { HOME, sortedDms, useDms, type DmEntry } from '../../stores/dms';
import { isUnread, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { usePreviewText } from '../chat/mentionText';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';

/**
 * «Личные» column (ADR-0020, Discord Home): «Найти или начать беседу» on top, then the DMs by
 * last activity — avatar with presence, name, the last message and its time, the unread count.
 * Same material, width and island padding as the room column (docs/08, Layout).
 */
export function DmSidebar(): ReactNode {
  const byRoom = useDms((s) => s.byRoom);
  const list = useMemo(() => sortedDms(byRoom), [byRoom]);
  const open = useUi((s) => s.openDialog);
  const ids = useMemo(() => list.map((e) => e.roomId), [list]);
  useEffect(() => {
    void loadDmPreviews(ids);
  }, [ids]);

  return (
    <aside className="mat-sidebar flex w-[var(--sidebar-width)] shrink-0 flex-col" aria-label={t('dm.list')}>
      <div className="flex h-12 shrink-0 items-center border-b border-line px-2.5">
        <button
          type="button"
          onClick={() => open({ kind: 'new-dm' })}
          className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-hover px-2.5 text-left text-body text-muted transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)] hover:text-fg"
        >
          <Search className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t('dm.find')}</span>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pt-2" style={{ paddingBottom: 'calc(var(--island-height, 0px) + 20px)' }}>
        <div className="group/cat flex h-7 items-center pr-1 pt-1">
          <h2 className="min-w-0 flex-1 truncate pl-2 text-micro font-semibold uppercase tracking-[0.04em] text-muted">{t('dm.list')}</h2>
          <Tip label={t('dm.new')}>
            <button
              type="button"
              onClick={() => open({ kind: 'new-dm' })}
              aria-label={t('dm.new')}
              className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg"
            >
              <Plus className="size-4" aria-hidden />
            </button>
          </Tip>
        </div>
        {list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-3 py-8 text-center text-body text-muted" data-testid="dm-empty">
            <p>{t('dm.empty')}</p>
            <p className="text-caption">{t('dm.emptyHint')}</p>
            <Button size="sm" onClick={() => open({ kind: 'new-dm' })}>
              <MessageCirclePlus className="size-3.5" aria-hidden /> {t('dm.new')}
            </Button>
          </div>
        ) : (
          <ul className="mt-0.5 flex flex-col gap-px" data-testid="dm-list">
            {list.map((e) => (
              <DmRow key={e.roomId} entry={e} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

/** «14:05» today, «вчера», «14 янв.» earlier. */
export function fmtListTime(ms: number, now = new Date()): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (d.toDateString() === now.toDateString()) return fmtTime(d);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'вчера';
  return dateFmt.format(d);
}

const DmRow = memo(function DmRow({ entry }: { entry: DmEntry }): ReactNode {
  const { roomId, peerId } = entry;
  const active = useUi((s) => s.activeWorkspaceId === HOME && s.lastRoom[HOME] === roomId);
  const name = useMemberName(null, peerId);
  const avatar = useWorkspaces((s) => s.users[peerId]?.avatarFileId ?? '');
  const unread = useRooms((s) => isUnread(roomId, s));
  const count = useRooms((s) => s.mentions[roomId] ?? 0);
  const preview = useDms((s) => s.preview[roomId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const text = usePreviewText(null, preview?.content ?? '');
  const line = preview === undefined ? '' : preview === null ? t('dm.noMessages') : `${preview.authorId === me ? `${t('dm.you')}: ` : ''}${text || (preview.attachments ? t('chat.attachment') : '')}`;
  const time = fmtListTime(preview?.at ?? entry.activity);
  const bright = active || unread;
  return (
    <DmMenu roomId={roomId} unread={unread}>
      <li className={cx('group/row relative flex h-[46px] items-center rounded-[var(--radius-row)] transition-colors duration-[var(--motion-fast)]', active ? 'bg-active' : 'hover:bg-hover')}>
        {unread && !active ? <span aria-hidden className="absolute -left-1.5 top-1/2 h-2 w-1 -translate-y-1/2 rounded-full bg-fg" /> : null}
        <button
          type="button"
          onClick={() => openDm(roomId)}
          aria-current={active ? 'page' : undefined}
          aria-label={[name, count > 0 ? t('shell.unreadMentions', { n: count }) : unread ? t('ws.unread') : ''].filter(Boolean).join(', ')}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-row)] pl-2 pr-2 text-left"
        >
          <Avatar userId={peerId} name={name} fileId={avatar || undefined} size={32} presence />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={cx('min-w-0 flex-1 truncate text-list leading-5', bright ? 'text-fg' : 'text-muted group-hover/row:text-fg', unread && !active && 'font-semibold')} title={name}>
                {name}
              </span>
              <span className="shrink-0 text-micro text-faint">{time}</span>
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <span className={cx('min-w-0 flex-1 truncate text-caption leading-4', unread && !active ? 'text-fg' : 'text-muted')}>{line}</span>
              {count > 0 ? (
                <span className="shrink-0 rounded-full bg-danger-fill px-1.5 text-micro font-bold leading-4 text-white" aria-hidden>
                  {count > 99 ? '99+' : count}
                </span>
              ) : null}
            </span>
          </span>
        </button>
      </li>
    </DmMenu>
  );
});

function DmMenu({ roomId, unread, children }: { roomId: string; unread: boolean; children: ReactNode }): ReactNode {
  const last = useRooms((s) => s.lastMessage[roomId]);
  const serverUrl = useSession((s) => s.serverUrl);
  const origin = shareOrigin(serverUrl);
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuBox}>
          <ContextMenu.Item
            className={menuItem}
            disabled={!last || !unread}
            onSelect={() => {
              if (!last) return;
              useRooms.getState().setRead(roomId, last);
              void api.messages.markRead(roomId, last).catch(() => undefined);
            }}
          >
            {t('dm.markRead')}
          </ContextMenu.Item>
          {origin ? (
            <>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Item
                className={menuItem}
                onSelect={() => void navigator.clipboard.writeText(`${origin}/dm/${roomId}`).then(() => toast.success(t('dm.linkCopied')))}
              >
                {t('dm.copyLink')}
              </ContextMenu.Item>
            </>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
