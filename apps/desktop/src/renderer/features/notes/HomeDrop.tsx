import { NotebookText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { SPRING_OPEN_MS, isMessageDrag, type DropAction, type DropTarget } from '../../lib/messageDrag';
import { shelfName } from '../../services/notes';
import { firstShelf, shelfTitle, sortedShelves, useNotes, type ShelfEntry } from '../../stores/notes';
import { useChatDrop } from '../chat/useChatDrop';
import { applyChatDrop } from './dropActions';

/**
 * The rail's «Личные» tile as a way into «Заметки» during a message drag (docs/05 «Заметки»):
 * dropping on the tile saves into the first shelf; holding over it for SPRING_OPEN_MS opens a
 * flyout of all shelves beside the rail (the feed and its dragged message stay where they are).
 * The flyout closes when the drag ends or the pointer leaves it and the tile.
 */
export function useHomeDrop(anchor: RefObject<HTMLElement | null>): { over: boolean; handlers: ReturnType<typeof useChatDrop>[1]; flyout: ReactNode } {
  const first = useNotes((s) => firstShelf(s.byRoom));
  const target = useMemo<DropTarget | null>(() => (first ? { kind: 'shelf', roomId: first, files: false, canSend: true } : null), [first]);
  const onDrop = useCallback((a: DropAction, files: File[]) => applyChatDrop(a, files, shelfName(a.toRoomId), true), []);
  const [over, drop] = useChatDrop(target, onDrop);
  // The open flyout's place (beside the tile, measured when it opens); null = closed.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const open = pos !== null;
  const timer = useRef<number | null>(null);
  const leave = useRef<number | null>(null);

  const clear = (ref: { current: number | null }): void => {
    if (ref.current !== null) window.clearTimeout(ref.current);
    ref.current = null;
  };
  // Any end of the drag closes the flyout.
  useEffect(() => {
    if (!open) return;
    const off = (): void => setPos(null);
    window.addEventListener('dragend', off, true);
    window.addEventListener('drop', off);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('dragend', off, true);
      window.removeEventListener('drop', off);
      window.removeEventListener('blur', off);
    };
  }, [open]);
  useEffect(
    () => () => {
      clear(timer);
      clear(leave);
    },
    [],
  );

  const enter = (e: DragEvent): void => {
    if (!isMessageDrag(e.dataTransfer.types)) return;
    clear(leave);
    if (open || timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const r = anchor.current?.getBoundingClientRect();
      setPos(r ? { left: r.right + 8, top: Math.max(8, r.top) } : { left: 80, top: 48 });
    }, SPRING_OPEN_MS);
  };
  const away = (): void => {
    clear(timer);
    clear(leave);
    leave.current = window.setTimeout(() => setPos(null), 350);
  };
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      enter(e);
      drop.onDragEnter(e);
    },
    onDragOver: (e: DragEvent) => {
      enter(e);
      drop.onDragOver(e);
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) away();
      drop.onDragLeave(e);
    },
    onDrop: (e: DragEvent) => {
      clear(timer);
      setPos(null);
      drop.onDrop(e);
    },
  };
  const flyout = pos ? <ShelfFlyout pos={pos} onEnter={() => clear(leave)} onLeave={away} /> : null;
  return { over, handlers, flyout };
}

function ShelfFlyout({ pos, onEnter, onLeave }: { pos: { left: number; top: number }; onEnter: () => void; onLeave: () => void }): ReactNode {
  const byRoom = useNotes((s) => s.byRoom);
  const list = useMemo(() => sortedShelves(byRoom), [byRoom]);
  return createPortal(
    <div
      role="menu"
      aria-label={t('notes.dropFlyout')}
      data-testid="notes-flyout"
      className="mat-popover anim-in fixed z-[var(--z-popover)] flex w-60 flex-col gap-px rounded-[var(--radius-panel)] p-1.5"
      style={{ left: pos.left, top: pos.top, maxHeight: `calc(100vh - ${pos.top + 16}px)` }}
      onDragEnter={onEnter}
      onDragOver={onEnter}
      onDragLeave={(e) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) onLeave();
      }}
    >
      <div className="px-2 pb-1 pt-0.5 text-micro font-semibold uppercase tracking-[0.04em] text-muted">{t('notes.dropFlyout')}</div>
      {list.length ? (
        <div className="flex min-h-0 flex-col gap-px overflow-y-auto">
          {list.map((e) => (
            <FlyoutRow key={e.roomId} entry={e} />
          ))}
        </div>
      ) : (
        <p className="px-2 py-1.5 text-caption text-muted">{t('notes.noShelf')}</p>
      )}
    </div>,
    document.body,
  );
}

function FlyoutRow({ entry }: { entry: ShelfEntry }): ReactNode {
  const target = useMemo<DropTarget>(() => ({ kind: 'shelf', roomId: entry.roomId, files: false, canSend: true }), [entry.roomId]);
  const onDrop = useCallback((a: DropAction, files: File[]) => applyChatDrop(a, files, shelfName(a.toRoomId), true), []);
  const [over, drop] = useChatDrop(target, onDrop);
  return (
    <div
      role="menuitem"
      data-testid="notes-flyout-shelf"
      className={cx(
        'flex h-9 items-center gap-2 rounded-[var(--radius-row)] px-2 text-list',
        over ? 'bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-fg shadow-[inset_0_0_0_1px_var(--color-accent)]' : 'text-muted',
      )}
      {...drop}
    >
      <span className="grid size-6 shrink-0 place-items-center text-[15px] leading-none" aria-hidden>
        {entry.emoji || <NotebookText className="size-4" strokeWidth={1.75} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{over ? t('notes.saveTo', { name: shelfTitle(entry) }) : entry.name}</span>
    </div>
  );
}
