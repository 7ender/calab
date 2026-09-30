import { WorkspaceRole } from '@calaba/protocol';
import { SquareKanban } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { unreadCount, useBoards } from '../../stores/boards';
import { useBoardsUi } from '../../stores/boardsUi';
import { useWorkspaces } from '../../stores/workspaces';

/**
 * The boards icon in the room column header (ADR-0042 §5), next to the calendar: the number of
 * unread tasks (hidden at 0, «9+»); a click switches the column and the centre to the boards and
 * back (state kept). Not for guests. Memo: the header re-renders with the room list.
 */
export const BoardsButton = memo(function BoardsButton({ workspaceId }: { workspaceId: string }): ReactNode {
  const count = useBoards((s) => unreadCount(s, workspaceId));
  const active = useBoardsUi((s) => s.active);
  const guest = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.GUEST);
  if (guest) return null;
  const label = count > 0 ? plural('boards.unreadCount', count) : active ? t('boards.close') : t('boards.openMode');
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        data-testid="boards-button"
        onClick={() => useBoardsUi.getState().toggle()}
        className={cx(
          'relative grid size-8 shrink-0 place-items-center rounded-[var(--radius-icon)] transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg',
          active ? 'bg-active text-fg' : 'text-muted',
        )}
      >
        <SquareKanban className="size-[18px]" aria-hidden />
        {count > 0 ? (
          <span
            aria-hidden
            data-testid="boards-count"
            className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent-strong px-1 text-micro font-semibold tabular-nums leading-none text-accent-fg"
          >
            {count > 9 ? '9+' : count}
          </span>
        ) : null}
      </button>
    </Tip>
  );
});
