import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { BoardStatus } from '@calaba/protocol';
import type { MatchCtx } from '../../lib/boards/filter';
import { useBoards } from '../../stores/boards';
import { useSession } from '../../stores/session';
import { useToday } from '../calendar/MiniCalendar';
import { useMobile } from '../../lib/mobile';
import { useBoardsUi, type ViewKind } from '../../stores/boardsUi';

const NONE: BoardStatus[] = [];

/**
 * The filter context of a board (me, its statuses, today): memoized, so the column selectors get
 * a stable object and a task event does not rebuild it.
 */
export function useMatchCtx(boardId: string): MatchCtx {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const statuses = useBoards(useShallow((s) => s.boards[boardId]?.statuses ?? NONE));
  const today = useToday();
  return useMemo(() => {
    const map: Record<string, Pick<BoardStatus, 'type'>> = {};
    for (const s of statuses) map[s.id] = { type: s.type };
    return { me, statuses: map, today };
  }, [me, statuses, today]);
}

/** The board's view: the viewer's choice, else kanban (a phone: the list, ADR-0042 §5). */
export function useViewKind(boardId: string): ViewKind {
  const mobile = useMobile();
  const kind = useBoardsUi((s) => s.prefs[boardId]?.kind);
  return kind ?? (mobile ? 'list' : 'kanban');
}
