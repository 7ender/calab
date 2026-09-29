import type { ReactNode } from 'react';
import { Modal } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { IS_MAC } from '../../services/hotkeys';
import { useBoardsUi } from '../../stores/boardsUi';
import { BOARD_HOTKEYS, chordLabel, type HotkeyGroup } from './hotkeys';

const GROUPS: ReadonlyArray<{ g: HotkeyGroup; label: MessageKey }> = [
  { g: 'general', label: 'boards.kbdGroup.general' },
  { g: 'navigation', label: 'boards.kbdGroup.navigation' },
  { g: 'task', label: 'boards.kbdGroup.task' },
  { g: 'move', label: 'boards.kbdGroup.move' },
];

/** A key cap. */
export function Kbd({ children }: { children: ReactNode }): ReactNode {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line bg-elev px-1.5 font-sans text-caption text-fg">{children}</kbd>;
}

/** The board keys by group (the registry): «?» in the boards mode, Settings → Горячие клавиши. */
export function BoardHotkeysList({ columns = 2 }: { columns?: 1 | 2 }): ReactNode {
  return (
    <div className={columns === 2 ? 'grid grid-cols-2 gap-x-6 gap-y-4 mobile:grid-cols-1' : 'flex flex-col gap-4'} data-testid="board-hotkeys">
      {GROUPS.map(({ g, label }) => (
        <section key={g} className="flex flex-col gap-1">
          <h3 className="pb-1 text-caption font-semibold text-muted">{t(label)}</h3>
          {BOARD_HOTKEYS.filter((h) => h.group === g).map((h) => (
            <div key={h.id} className="flex min-h-7 items-center gap-3 text-body" data-settings-row>
              <span className="min-w-0 flex-1" data-settings-label>
                {t(h.label)}
              </span>
              <span className="flex shrink-0 gap-1">
                {h.chords.map((c, i) => (
                  <Kbd key={i}>{chordLabel(c, IS_MAC)}</Kbd>
                ))}
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function HotkeysSheet(): ReactNode {
  const open = useBoardsUi((s) => s.helpOpen);
  if (!open) return null;
  return (
    <Modal open wide onClose={() => useBoardsUi.getState().setHelpOpen(false)} title={t('boards.kbdTitle')} description={t('boards.kbdHint')}>
      <BoardHotkeysList />
    </Modal>
  );
}
