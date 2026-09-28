import type { PermissionBits } from '@calaba/protocol';
import { CornerUpLeft, Ellipsis, SmilePlus } from 'lucide-react';
import { useMemo, type MouseEvent, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { can } from '../../lib/permissions';
import { toggleReaction } from '../../services/chat';
import type { ChatMessage } from '../../stores/messages';
import { useUi } from '../../stores/ui';
import { useChatView } from './chatView';
import { EmojiPicker } from './EmojiPicker';
import { quickReactions } from './hoverIntent';
import { canToggleReaction, reactionLimitReached } from './reactionLimit';

/** Whether the bar has anything to offer (the same rules as the context menu, MessageMenu.tsx). */
export function hasMessageActions(c: ChatMessage, own: boolean, perms: PermissionBits): boolean {
  if (c.status !== 'sent') return false;
  return can(perms, 'SEND_MESSAGES') || !!c.msg.content || can(perms, 'MANAGE_MESSAGES') || own;
}

const btn =
  'grid size-6 shrink-0 cursor-default place-items-center rounded-[5px] text-muted outline-offset-0 hover:bg-hover hover:text-fg';

/**
 * Hover action bar of a message (docs/09 #47): quick reactions + picker, reply, «Ещё…» — the
 * last opens the very same context menu as a right click. Opaque popover, 28 px. Reactions and
 * reply follow SEND_MESSAGES, like the menu.
 */
export function MessageActions({
  c,
  roomId,
  perms,
  onPickerOpenChange,
}: {
  c: ChatMessage;
  roomId: string;
  perms: PermissionBits;
  onPickerOpenChange: (open: boolean) => void;
}): ReactNode {
  const m = c.msg;
  const canSend = can(perms, 'SEND_MESSAGES');
  const recent = useChatView((s) => s.recentEmoji);
  const quick = useMemo(() => quickReactions(recent), [recent]);
  // At the per-user limit (docs/09 #27) new emojis are dimmed with a hint; own ones stay removable.
  const limited = reactionLimitReached(m.reactions);
  const limitHint = limited ? t('chat.reactionLimit') : undefined;

  const react = (emoji: string): void => {
    useChatView.getState().pushRecent(emoji);
    void toggleReaction(roomId, m, emoji);
  };
  // «Ещё…»: a synthetic right click on the bubble opens its Radix context menu under the button.
  const more = (e: MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left, clientY: r.bottom + 4 }),
    );
  };

  return (
    <div
      role="group"
      aria-label={t('chat.actions')}
      data-testid="message-actions"
      className="mat-popover anim-in pointer-events-auto flex h-7 shrink-0 select-none items-center gap-0.5 rounded-[var(--radius-card)] px-0.5"
    >
      {canSend ? (
        <>
          {quick.map((e) => {
            const mine = m.reactions.some((r) => r.emoji === e && r.me);
            const blocked = !canToggleReaction(m.reactions, e);
            const button = (
              <button
                key={e}
                type="button"
                aria-label={t('chat.reactWith', { emoji: e })}
                aria-pressed={mine}
                aria-disabled={blocked || undefined}
                onClick={() => (blocked ? void toggleReaction(roomId, m, e) : react(e))}
                className={cx(
                  btn,
                  'text-headline leading-none',
                  mine && 'bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)]',
                  blocked && 'opacity-40 hover:bg-transparent',
                )}
              >
                {e}
              </button>
            );
            return blocked && limitHint ? (
              <Tip key={e} label={limitHint}>
                {button}
              </Tip>
            ) : (
              button
            );
          })}
          <EmojiPicker
            onPick={(e) => void toggleReaction(roomId, m, e)}
            label={limitHint ?? t('chat.addReaction')}
            onOpenChange={onPickerOpenChange}
            closeOnPick
            canPick={(e) => canToggleReaction(m.reactions, e)}
            hint={limitHint}
          >
            <button type="button" aria-label={t('chat.addReaction')} className={btn}>
              <SmilePlus className="size-4" aria-hidden />
            </button>
          </EmojiPicker>
          <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
          <Tip label={t('chat.reply')}>
            <button type="button" aria-label={t('chat.reply')} onClick={() => useUi.getState().setReply(roomId, m.id)} className={btn}>
              <CornerUpLeft className="size-4" aria-hidden />
            </button>
          </Tip>
        </>
      ) : null}
      <Tip label={t('chat.more')}>
        <button type="button" aria-label={t('chat.more')} aria-haspopup="menu" onClick={more} className={btn}>
          <Ellipsis className="size-4" aria-hidden />
        </button>
      </Tip>
    </div>
  );
}
