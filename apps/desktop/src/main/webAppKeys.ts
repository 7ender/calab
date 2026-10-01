import type { WebAppNavAction } from '../shared/ipc';

/** The bits of an Electron `Input` the shortcut check reads. */
export interface KeyInput {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * Navigation shortcuts of a focused web app view (ADR-0050 «Уточнение»: the toolbar is gone):
 * ⌘/Ctrl+[ back, ⌘/Ctrl+] forward, ⌘/Ctrl+R reload. `mac` selects the modifier (⌘ on macOS,
 * Ctrl elsewhere); Shift/Alt variants are left to the page. Null = not ours.
 */
export function navShortcut(input: KeyInput, mac: boolean): WebAppNavAction | null {
  if (input.type !== 'keyDown' || input.alt || input.shift) return null;
  if (mac ? !input.meta || input.control : !input.control || input.meta) return null;
  switch (input.key) {
    case '[':
      return 'back';
    case ']':
      return 'forward';
    case 'r':
    case 'R':
      return 'reload';
    default:
      return null;
  }
}
