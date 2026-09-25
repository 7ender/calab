import { useUi } from '../stores/ui';
import { voice } from './voice';

/**
 * Global in-window shortcuts (docs/08, «UX-правила»):
 * ⌘/Ctrl+K — quick switcher, ⌘/Ctrl+Shift+M — mute, ⌘/Ctrl+Shift+D — deafen.
 * Esc closes the top layer (Radix dialogs/menus handle it themselves).
 */
export const SHORTCUTS = {
  quickSwitch: 'K',
  mute: 'Shift+M',
  deafen: 'Shift+D',
} as const;

export function installHotkeys(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape' && !mod) {
      // The floating members panel is a layer too (dialogs/menus close themselves).
      const ui = useUi.getState();
      if (ui.membersOverlay && !ui.dialog && !e.defaultPrevented) ui.setMembersOverlay(false);
      return;
    }
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'k' && !e.shiftKey) {
      e.preventDefault();
      const ui = useUi.getState();
      ui.openDialog(ui.dialog?.kind === 'quick-switcher' ? null : { kind: 'quick-switcher' });
    } else if (k === 'm' && e.shiftKey) {
      e.preventDefault();
      voice.toggleMute();
    } else if (k === 'd' && e.shiftKey) {
      e.preventDefault();
      voice.toggleDeafen();
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
