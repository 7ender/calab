import * as Dropdown from '@radix-ui/react-dropdown-menu';
import type { Board } from '@calaba/protocol';
import { Archive, ArchiveRestore, ChevronRight, Ellipsis, Inbox, Link2, Lock, Plus, Settings, Shield, SquareKanban, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { confirmAction } from '../../components/Confirm';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { mayCreateBoards } from '../../lib/permissions';
import { boardLink, copyText, listArchivedBoards, moveBoard, openBoard, removeBoard, restoreBoard } from '../../services/boards';
import { DeleteBoardDialog } from './BoardSettings';
import { unreadCount, useBoards, workspaceBoards } from '../../stores/boards';
import { MY_TASKS, useBoardsUi } from '../../stores/boardsUi';
import { useSession } from '../../stores/session';
import { useMemberRoles } from '../../stores/workspaces';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { RestrictedMark } from '../workspace/AccessLevel';
import { hasBit, MANAGE_BOARD } from './model';

/**
 * The room column in boards mode (ADR-0042 §5): «Мои задачи» on top, the workspace's boards
 * (emoji, name, my open tasks) in their order — dragged to reorder with MANAGE_BOARD (accent line,
 * Esc cancels), ⋯ → settings / access / link / archive — and «+ Доска» for CREATE_BOARDS (ADR-0048).
 */
export function BoardsList({ workspaceId }: { workspaceId: string }): ReactNode {
  const ids = useBoards(useShallow((s) => workspaceBoards(s.boards, workspaceId).map((b) => b.id)));
  const me = useSession((s) => s.me?.user?.id ?? '');
  // «+ Доска»: CREATE_BOARDS (ADR-0048).
  const creator = mayCreateBoards(useMemberRoles(workspaceId, me));
  const manageAny = useBoards((s) => workspaceBoards(s.boards, workspaceId).some((b) => hasBit(b.permissions, MANAGE_BOARD)));
  const list = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [line, setLine] = useState<number | null>(null);
  const press = useRef<{ id: string; y: number; started: boolean } | null>(null);
  const target = useRef<number | null>(null);
  const suppress = useRef(false);

  const measure = useCallback((y: number, id: string): void => {
    const el = list.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll<HTMLElement>('[data-board-row]')];
    let i = rows.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return y < b.top + b.height / 2;
    });
    if (i < 0) i = rows.length;
    const from = rows.findIndex((r) => r.dataset.boardRow === id);
    target.current = i > from ? i - 1 : i;
    const ref = rows[i]?.getBoundingClientRect() ?? rows[rows.length - 1]?.getBoundingClientRect();
    if (!ref) return;
    setLine((rows[i] ? ref.top : ref.bottom) - box.top);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const p = press.current;
      if (!p) return;
      if (!p.started) {
        if (Math.abs(e.clientY - p.y) < 6) return;
        p.started = true;
        setDrag(p.id);
      }
      measure(e.clientY, p.id);
    };
    const end = (commit: boolean): void => {
      const p = press.current;
      press.current = null;
      if (!p?.started) return;
      suppress.current = true;
      window.setTimeout(() => (suppress.current = false), 0);
      const to = target.current;
      setDrag(null);
      setLine(null);
      target.current = null;
      if (commit && to !== null) void moveBoard(workspaceId, p.id, to);
    };
    const up = (): void => end(true);
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && press.current?.started) {
        e.stopPropagation();
        end(false);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
    };
  }, [measure, workspaceId]);

  const onPointerDown = useCallback((e: ReactPointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-row-menu]')) return;
    const b = useBoards.getState().boards[id];
    if (!hasBit(b?.permissions, MANAGE_BOARD)) return;
    press.current = { id, y: e.clientY, started: false };
  }, []);

  return (
    <div
      ref={list}
      className="scrollbar-none relative min-h-0 flex-1 overflow-y-auto px-2 pt-2"
      style={{ paddingBottom: 'calc(var(--island-height, 0px) + 20px)' }}
      onClickCapture={(e) => {
        if (suppress.current) {
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      data-testid="boards-list"
    >
      <MyTasksRow workspaceId={workspaceId} />
      <div className="flex h-7 items-center pl-2 pr-1 pt-2">
        <h2 className="min-w-0 flex-1 truncate text-micro font-semibold uppercase tracking-[0.04em] text-muted">{t('boards.boards')}</h2>
        {creator ? (
          <Tip label={t('boards.newBoard')}>
            <button type="button" aria-label={t('boards.newBoard')} onClick={() => useBoardsUi.getState().openSettings({ boardId: '', workspaceId })} className="grid size-6 place-items-center rounded-[var(--radius-icon)] text-muted hover:bg-hover hover:text-fg" data-testid="board-new">
              <Plus className="size-4" aria-hidden />
            </button>
          </Tip>
        ) : null}
      </div>
      <div className="flex flex-col gap-px pt-0.5">
        {ids.map((id) => (
          <BoardRow key={id} id={id} workspaceId={workspaceId} dragging={drag === id} onPointerDown={onPointerDown} />
        ))}
      </div>
      {ids.length === 0 ? (
        creator ? (
          <button
            type="button"
            onClick={() => useBoardsUi.getState().openSettings({ boardId: '', workspaceId })}
            className="mt-1 flex w-full items-center gap-2.5 rounded-[var(--radius-row)] border border-dashed border-line px-2 py-2 text-left text-caption text-muted hover:bg-hover hover:text-fg"
            data-testid="boards-empty"
          >
            <Plus className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{t('boards.noBoardsAdmin')}</span>
          </button>
        ) : (
          <p className="px-2 py-3 text-caption text-muted" data-testid="boards-empty">
            {t('boards.noBoards')}
          </p>
        )
      ) : null}
      {creator || manageAny ? <ArchivedBoards workspaceId={workspaceId} live={ids.length} /> : null}
      {line !== null ? <div aria-hidden className="pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded-full bg-accent" style={{ top: Math.max(0, line - 1) }} /> : null}
    </div>
  );
}

function MyTasksRow({ workspaceId }: { workspaceId: string }): ReactNode {
  const active = useBoardsUi((s) => s.boardOf[workspaceId] === MY_TASKS);
  const unread = useBoards((s) => unreadCount(s, workspaceId));
  return (
    <button
      type="button"
      onClick={() => openBoard(workspaceId, MY_TASKS)}
      aria-current={active ? 'page' : undefined}
      className={cx('flex h-8 w-full items-center gap-2 rounded-[var(--radius-row)] px-2 text-left text-list', active ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg')}
      data-testid="my-tasks"
    >
      <Inbox className="size-[18px] shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{t('boards.myTasks')}</span>
      {unread > 0 ? <span className="grid h-4 min-w-4 place-items-center rounded-full bg-accent-strong px-1 text-micro font-semibold tabular-nums text-accent-fg">{unread > 99 ? '99+' : unread}</span> : null}
    </button>
  );
}

const BoardRow = memo(function BoardRow({ id, workspaceId, dragging, onPointerDown }: { id: string; workspaceId: string; dragging: boolean; onPointerDown: (e: ReactPointerEvent, id: string) => void }): ReactNode {
  const name = useBoards((s) => s.boards[id]?.name ?? '');
  const emoji = useBoards((s) => s.boards[id]?.emoji ?? '');
  const priv = useBoards((s) => s.boards[id]?.isPrivate ?? false);
  const restricted = useBoards((s) => s.boards[id]?.restricted ?? false);
  const mine = useBoards((s) => s.boards[id]?.myOpenTasks ?? 0);
  const perms = useBoards((s) => s.boards[id]?.permissions);
  const active = useBoardsUi((s) => s.boardOf[workspaceId] === id);
  const manage = hasBit(perms, MANAGE_BOARD);
  const archive = async (): Promise<void> => {
    if (await confirmAction(t('boards.archiveBoardTitle', { name }), t('boards.archiveBoardText'), t('boards.archiveBoard'))) void removeBoard(id, false);
  };
  return (
    <div
      data-board-row={id}
      onPointerDown={(e) => onPointerDown(e, id)}
      className={cx('group/board flex h-8 items-center rounded-[var(--radius-row)] pr-1', active ? 'bg-active' : 'hover:bg-hover', dragging && 'opacity-40')}
      data-testid="board-row"
    >
      <button type="button" onClick={() => openBoard(workspaceId, id)} aria-current={active ? 'page' : undefined} className={cx('flex h-8 min-w-0 flex-1 items-center gap-2 pl-2 text-left text-list', active ? 'font-medium text-fg' : 'text-muted group-hover/board:text-fg')}>
        <span className="grid w-[18px] shrink-0 place-items-center text-[15px] leading-none" aria-hidden>
          {emoji || <SquareKanban className="size-[18px]" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {priv ? <Lock className="size-3.5 shrink-0 text-faint" aria-label={t('boards.private')} /> : null}
        {restricted ? <RestrictedMark /> : null}
        {mine > 0 ? (
          <span className="shrink-0 text-caption tabular-nums text-muted" title={t('boards.myOpen')}>
            {mine}
          </span>
        ) : null}
      </button>
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button type="button" data-row-menu aria-label={t('boards.boardMenu', { name })} className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/board:opacity-100 data-[state=open]:opacity-100">
            <Ellipsis className="size-4" aria-hidden />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={cx(menuBox, 'min-w-56')} sideOffset={4} align="start" collisionPadding={16}>
            {manage ? (
              <>
                <Dropdown.Item className={menuItem} onSelect={() => useBoardsUi.getState().openSettings({ boardId: id, workspaceId })}>
                  <Settings className="size-4" aria-hidden /> {t('boards.settings')}
                </Dropdown.Item>
                <Dropdown.Item className={menuItem} onSelect={() => useBoardsUi.getState().openSettings({ boardId: id, workspaceId, tab: 'access' })}>
                  <Shield className="size-4" aria-hidden /> {t('boards.access')}
                </Dropdown.Item>
              </>
            ) : null}
            <Dropdown.Item className={menuItem} onSelect={() => copyText(boardLink(id), t('boards.linkCopied'))}>
              <Link2 className="size-4" aria-hidden /> {t('boards.copyLink')}
            </Dropdown.Item>
            {manage ? (
              <>
                <Dropdown.Separator className={menuSeparator} />
                <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void archive()}>
                  <Archive className="size-4" aria-hidden /> {t('boards.archive')}
                </Dropdown.Item>
              </>
            ) : null}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </div>
  );
});

/**
 * «Архив» under the boards (ADR-0042 §3, MANAGE_BOARD): the archived boards the viewer manages
 * (shown only when there are some; refetched when a board is archived / restored) —
 * «Восстановить» brings one back, the bin deletes it for good after the key is typed.
 */
function ArchivedBoards({ workspaceId, live }: { workspaceId: string; live: number }): ReactNode {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Board[]>([]);
  const [purge, setPurge] = useState<Board | null>(null);
  useEffect(() => {
    let alive = true;
    void listArchivedBoards(workspaceId).then((l) => {
      if (alive) setList(l);
    });
    return () => {
      alive = false;
    };
  }, [workspaceId, live]);
  const drop = (id: string): void => setList((l) => l.filter((b) => b.id !== id));
  if (!list.length && !purge) return null;
  return (
    <div className="pt-3" data-testid="boards-archive">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-7 w-full items-center gap-1 rounded-[var(--radius-row)] pl-1 pr-2 text-left text-micro font-semibold uppercase tracking-[0.04em] text-muted hover:bg-hover hover:text-fg"
        data-testid="boards-archive-toggle"
      >
        <ChevronRight className={cx('size-3.5 transition-transform duration-[var(--motion-fast)]', open && 'rotate-90')} aria-hidden />
        {t('boards.archiveSection')}
        <span className="font-normal tabular-nums">{list.length}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-px pt-0.5">
            {list.map((b) => (
              <div key={b.id} className="group/arch flex h-8 items-center gap-2 rounded-[var(--radius-row)] pl-2 pr-1 text-list text-muted hover:bg-hover" data-testid="archived-board">
                <span className="grid w-[18px] shrink-0 place-items-center text-[15px] leading-none opacity-60" aria-hidden>
                  {b.emoji || <SquareKanban className="size-[18px]" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                <Tip label={t('boards.restoreBoard')}>
                  <button
                    type="button"
                    aria-label={t('boards.restoreBoard')}
                    onClick={() =>
                      void restoreBoard(b.id).then((r) => {
                        if (r) drop(b.id);
                      })
                    }
                    className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] hover:bg-hover hover:text-fg"
                    data-testid="board-restore"
                  >
                    <ArchiveRestore className="size-4" aria-hidden />
                  </button>
                </Tip>
                <Tip label={t('boards.deleteBoard')}>
                  <button
                    type="button"
                    aria-label={t('boards.deleteBoard')}
                    onClick={() => setPurge(b)}
                    className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] hover:bg-hover hover:text-danger-text"
                    data-testid="board-purge"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </Tip>
              </div>
            ))}
        </div>
      ) : null}
      {purge ? <DeleteBoardDialog board={purge} onClose={() => setPurge(null)} onDone={() => drop(purge.id)} /> : null}
    </div>
  );
}
