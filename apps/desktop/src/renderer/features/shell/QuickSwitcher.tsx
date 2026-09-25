import * as DialogP from '@radix-ui/react-dialog';
import { RoomType } from '@calaba/protocol';
import { Hash, Search, Volume2 } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { voice } from '../../services/voice';
import { useRooms } from '../../stores/rooms';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';

/** ⌘/Ctrl+K: jump to any room of any workspace by name. */
export function QuickSwitcher({ onClose }: { onClose: () => void }): ReactNode {
  const rooms = useRooms((s) => s.byId);
  const workspaces = useWorkspaces((s) => s.byId);
  const openRoom = useUi((s) => s.openRoom);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return Object.values(rooms)
      .filter((r) => workspaces[r.workspaceId])
      .filter((r) => !needle || r.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
      .slice(0, 50);
  }, [q, rooms, workspaces]);

  const go = (i: number): void => {
    const r = items[i];
    if (!r) return;
    openRoom(r.workspaceId, r.id);
    if (r.type === RoomType.VOICE && useVoice.getState().roomId !== r.id) void voice.join(r.id, r.workspaceId);
    onClose();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((v) => Math.min(items.length - 1, v + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((v) => Math.max(0, v - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(sel);
    }
  };

  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content
          aria-label={t('switcher.title')}
          className="mat-popover anim-in fixed left-1/2 top-[18vh] z-[var(--z-modal)] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-[var(--radius-panel)] focus:outline-none"
        >
          <DialogP.Title className="sr-only">{t('switcher.title')}</DialogP.Title>
          <DialogP.Description className="sr-only">{t('switcher.hint')}</DialogP.Description>
          <div className="flex items-center gap-2 border-b border-line px-4">
            <Search className="size-4 text-faint" strokeWidth={1.75} aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              onKeyDown={onKey}
              placeholder={t('switcher.placeholder')}
              aria-label={t('switcher.placeholder')}
              className="h-12 flex-1 bg-transparent text-[16px] text-fg placeholder:text-faint focus:outline-none"
            />
          </div>
          <ul role="listbox" aria-label={t('switcher.title')} className="max-h-[50vh] overflow-y-auto p-1.5">
            {items.length === 0 ? <li className="px-3 py-6 text-center text-[13px] text-muted">{t('switcher.empty')}</li> : null}
            {items.map((r, i) => (
              <li key={r.id} role="option" aria-selected={i === sel}>
                <button
                  type="button"
                  onMouseEnter={() => setSel(i)}
                  onClick={() => go(i)}
                  className={cx(
                    'flex h-9 w-full items-center gap-2 rounded-[var(--radius-control)] px-3 text-left text-[13px]',
                    i === sel ? 'bg-accent text-accent-fg' : 'text-fg',
                  )}
                >
                  {r.type === RoomType.VOICE ? <Volume2 className="size-4 shrink-0" strokeWidth={1.75} /> : <Hash className="size-4 shrink-0" strokeWidth={1.75} />}
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  <span className={cx('shrink-0 truncate text-[12px]', i === sel ? 'text-accent-fg/80' : 'text-faint')}>{workspaces[r.workspaceId]?.ws.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}
