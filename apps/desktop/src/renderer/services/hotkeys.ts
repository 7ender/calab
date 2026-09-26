import type { MessageKey } from '../i18n';
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

const IS_MAC = typeof navigator !== 'undefined' && /Mac OS X|Macintosh/.test(navigator.userAgent);

/** Room history: ⌘[ / ⌘] on macOS (Finder, Safari), Alt+← / Alt+→ on Windows/Linux. */
export const NAV_SHORTCUTS = IS_MAC ? { back: '⌘[', forward: '⌘]' } : { back: 'Alt+←', forward: 'Alt+→' };

/** Everything listed in the «?» help popover of the title bar. */
export function shortcutHelp(): Array<{ keys: string; label: MessageKey }> {
  const mod = IS_MAC ? '⌘' : 'Ctrl+';
  const shift = IS_MAC ? '⇧' : 'Shift+';
  return [
    { keys: `${mod}K`, label: 'shell.kbd.search' },
    { keys: NAV_SHORTCUTS.back, label: 'shell.kbd.back' },
    { keys: NAV_SHORTCUTS.forward, label: 'shell.kbd.forward' },
    { keys: `${mod}${shift}M`, label: 'shell.kbd.mute' },
    { keys: `${mod}${shift}D`, label: 'shell.kbd.deafen' },
    { keys: 'Esc', label: 'shell.kbd.esc' },
  ];
}

// e.code: layout-independent (on a Russian layout `[` is «х»).
const isNavBack = (e: KeyboardEvent): boolean =>
  IS_MAC ? e.metaKey && !e.shiftKey && !e.altKey && e.code === 'BracketLeft' : e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowLeft';
const isNavForward = (e: KeyboardEvent): boolean =>
  IS_MAC ? e.metaKey && !e.shiftKey && !e.altKey && e.code === 'BracketRight' : e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowRight';

export function installHotkeys(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape' && !mod) {
      // The floating members panel is a layer too (dialogs/menus close themselves).
      const ui = useUi.getState();
      if (ui.membersOverlay && !ui.dialog && !e.defaultPrevented) ui.setMembersOverlay(false);
      return;
    }
    if (isNavBack(e)) {
      e.preventDefault();
      useUi.getState().goBack();
      return;
    }
    if (isNavForward(e)) {
      e.preventDefault();
      useUi.getState().goForward();
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
