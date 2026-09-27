import type { PermissionBits } from '@calaba/protocol';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { Copy, CornerUpLeft, Link2, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { can, mayPin } from '../../lib/permissions';
import { firstLink, parseMarkdown } from '../../lib/markdown/parse';
import { deleteMessage, setEmbedsHidden, setPinned, toggleReaction } from '../../services/chat';
import { useRooms } from '../../stores/rooms';
import type { ChatMessage } from '../../stores/messages';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useChatView } from './chatView';
import { QUICK_REACTIONS } from './emoji';
import { canToggleReaction } from './reactionLimit';

/** macOS menu look (popover glass, 28 px rows, accent highlight). */
export const menuBox = 'mat-popover anim-in z-[var(--z-popover)] min-w-56 rounded-[var(--radius-card)] p-1';
export const menuItem =
  'flex h-7 cursor-default items-center gap-2 rounded-[5px] px-2 text-body text-fg outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent-strong data-[highlighted]:text-accent-fg';

/** Text selected inside this message, if any (copy copies the selection first, like Telegram). */
function selectionWithin(key: string): string {
  const sel = window.getSelection();
  const text = sel?.toString() ?? '';
  if (!text || !sel?.anchorNode) return '';
  const el = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement;
  return el?.closest(`[data-message-id="${CSS.escape(key)}"]`) ? text : '';
}

/**
 * The menu never grows over the composer: its bottom boundary is the composer's top edge (plus a
 * gap), so near the bottom it opens upward from the pointer (Radix shifts it inside the boundary).
 */
function menuPadding(): { top: number; right: number; bottom: number; left: number } {
  const composer = document.querySelector('[data-testid="composer"]');
  const top = composer ? composer.getBoundingClientRect().top : window.innerHeight;
  return { top: 8, right: 8, left: 8, bottom: Math.max(8, window.innerHeight - top + 8) };
}

/** Right click / long press on a bubble (docs/09 #38); also «Ещё…» of the hover bar (MessageActions.tsx). */
export function MessageMenu({ c, own, roomId, perms }: { c: ChatMessage; own: boolean; roomId: string; perms: PermissionBits }): ReactNode {
  const m = c.msg;
  const canSend = can(perms, 'SEND_MESSAGES');
  const canManage = can(perms, 'MANAGE_MESSAGES');
  // Pinning: MANAGE_MESSAGES, or either participant of a DM (docs/04).
  const canPin = mayPin(perms, useRooms.getState().byId[roomId]);
  const canDelete = own || canManage;
  const pinned = !!m.pinnedAt;
  // A hidden link preview can be brought back by whoever may hide it (the menu renders only open).
  const canShowEmbed = m.embedsHidden && (own || canManage) && !!firstLink(parseMarkdown(m.content));

  const copy = (): void => {
    const text = selectionWithin(c.key) || m.content;
    void navigator.clipboard.writeText(text).then(() => toast.success(t('chat.copied')));
  };
  const remove = async (): Promise<void> => {
    if (await confirmAction(t('chat.deleteTitle'), t('chat.deleteText'), t('common.delete'))) await deleteMessage(roomId, m.id);
  };

  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className={menuBox} aria-label={t('chat.menu')} collisionPadding={menuPadding()}>
        {canSend ? (
          <>
            <div className="flex items-center gap-0.5 px-0.5 pb-1 pt-0.5" role="group" aria-label={t('chat.react')}>
              {QUICK_REACTIONS.map((e) => {
                const mine = m.reactions.some((r) => r.emoji === e && r.me);
                // Past the per-user limit (docs/09 #27): dimmed; a pick shows the hint instead.
                const blocked = !canToggleReaction(m.reactions, e);
                return (
                  <ContextMenu.Item
                    key={e}
                    aria-label={e}
                    aria-disabled={blocked || undefined}
                    onSelect={() => {
                      if (!blocked) useChatView.getState().pushRecent(e);
                      void toggleReaction(roomId, m, e);
                    }}
                    className={cx(
                      'grid size-8 cursor-default place-items-center rounded-full text-title outline-none transition-transform duration-[var(--motion-fast)] data-[highlighted]:scale-110 data-[highlighted]:bg-hover',
                      mine && 'bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)]',
                      blocked && 'opacity-40',
                    )}
                  >
                    {e}
                  </ContextMenu.Item>
                );
              })}
            </div>
            <ContextMenu.Separator className="mx-1 my-1 h-px bg-line" />
            <ContextMenu.Item className={menuItem} onSelect={() => useUi.getState().setReply(roomId, m.id)}>
              <CornerUpLeft className="size-4" aria-hidden /> {t('chat.reply')}
            </ContextMenu.Item>
          </>
        ) : null}
        {m.content ? (
          <ContextMenu.Item className={menuItem} onSelect={copy}>
            <Copy className="size-4" aria-hidden /> {t('chat.copy')}
          </ContextMenu.Item>
        ) : null}
        {canPin ? (
          <ContextMenu.Item className={menuItem} onSelect={() => void setPinned(m, !pinned)}>
            {pinned ? <PinOff className="size-4" aria-hidden /> : <Pin className="size-4" aria-hidden />}
            {pinned ? t('chat.unpin') : t('chat.pin')}
          </ContextMenu.Item>
        ) : null}
        {canShowEmbed ? (
          <ContextMenu.Item className={menuItem} onSelect={() => void setEmbedsHidden(m, false)}>
            <Link2 className="size-4" aria-hidden /> {t('chat.embedShow')}
          </ContextMenu.Item>
        ) : null}
        {own && !m.sticker ? (
          <ContextMenu.Item className={menuItem} onSelect={() => useUi.getState().setEditing(c.key)}>
            <Pencil className="size-4" aria-hidden /> {t('chat.edit')}
          </ContextMenu.Item>
        ) : null}
        {canDelete ? (
          <>
            <ContextMenu.Separator className="mx-1 my-1 h-px bg-line" />
            <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()}>
              <Trash2 className="size-4" aria-hidden /> {t('common.delete')}
            </ContextMenu.Item>
          </>
        ) : null}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}
