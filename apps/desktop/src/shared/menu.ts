/**
 * macOS application / Dock menu contract (docs/08 «Меню macOS»). The renderer owns the app state
 * and the dictionaries (ADR-0022): it pushes a small summary (`MenuState`, IPC `menu:state`) and
 * the translated labels (MainStrings `menu*`); main builds the native menus from them
 * (main/menuModel.ts) and sends the renderer's commands back as `MenuAction` ids (`menu:action`).
 */

/** Commands the renderer carries out; `workspace:<id>` switches to that workspace. */
export type MenuAction =
  | 'about'
  | 'settings'
  | 'shortcuts'
  | 'new-message'
  | 'room-create'
  | 'invite'
  | 'search'
  | 'members'
  | 'dms'
  | 'toggle-mute'
  | 'toggle-deafen'
  | 'toggle-camera'
  | 'share-screen'
  | 'leave-voice'
  | `workspace:${string}`;

export const MENU_ACTIONS = [
  'about',
  'settings',
  'shortcuts',
  'new-message',
  'room-create',
  'invite',
  'search',
  'members',
  'dms',
  'toggle-mute',
  'toggle-deafen',
  'toggle-camera',
  'share-screen',
  'leave-voice',
] as const satisfies ReadonlyArray<MenuAction>;

export interface MenuVoice {
  /** Joined a voice room or a one-to-one call. */
  inRoom: boolean;
  muted: boolean;
  deafened: boolean;
  /** My camera is on (or starting). */
  camera: boolean;
  /** The camera can be toggled now (connected, room allows it / it is on). */
  canCamera: boolean;
  /** I am sharing my screen. */
  streaming: boolean;
  /** «Показ экрана…» can start (connected, STREAM right) or stop. */
  canStream: boolean;
}

export interface MenuWorkspace {
  id: string;
  name: string;
}

export interface MenuState {
  /** Signed in and the shell is shown: the app items are enabled. */
  signedIn: boolean;
  voice: MenuVoice;
  /** The rail order; the first nine get ⌘1…⌘9. */
  workspaces: MenuWorkspace[];
  /** The open workspace (radio mark); null / «Личные» — none. */
  activeWorkspaceId: string | null;
  /** MANAGE_ROOM in the open workspace («Создать комнату…»). */
  canCreateRoom: boolean;
  /** MANAGE_WORKSPACE in the open workspace («Пригласить в пространство…»). */
  canInvite: boolean;
  /**
   * The rebindable in-window shortcuts as Electron accelerators (renderer/lib/shortcuts.ts
   * `comboAccelerator` of the effective bindings) — shown next to their items. '' = none.
   */
  hotkeys: { search: string; mute: string; deafen: string };
}

export const EMPTY_MENU_STATE: MenuState = {
  signedIn: false,
  voice: { inRoom: false, muted: false, deafened: false, camera: false, canCamera: false, streaming: false, canStream: false },
  workspaces: [],
  activeWorkspaceId: null,
  canCreateRoom: false,
  canInvite: false,
  hotkeys: { search: '', mute: '', deafen: '' },
};

/**
 * Fixed accelerators of menu-only commands (the renderer does not listen for them). Rebindable
 * shortcuts must not take them: lib/shortcuts.ts RESERVED covers these (asserted in its test).
 */
export const MENU_ACCELERATORS = {
  newMessage: 'CommandOrControl+N',
  settings: 'CommandOrControl+,',
  /** ⌘1…⌘9 — the first nine workspaces. */
  workspace: (index: number): string | undefined => (index < 9 ? `CommandOrControl+${index + 1}` : undefined),
} as const;

export const MENU_WORKSPACES_MAX = 50;
const ACCEL = /^[A-Za-z0-9+\-=[\];',./\\`]{0,64}$/;

const bool = (v: unknown): boolean => v === true;

/** Validates the renderer's payload (IPC input): unknown fields dropped, bad values → defaults. */
export function parseMenuState(v: unknown): MenuState {
  if (typeof v !== 'object' || v === null) return EMPTY_MENU_STATE;
  const r = v as Record<string, unknown>;
  const vo = (typeof r['voice'] === 'object' && r['voice'] !== null ? r['voice'] : {}) as Record<string, unknown>;
  const hk = (typeof r['hotkeys'] === 'object' && r['hotkeys'] !== null ? r['hotkeys'] : {}) as Record<string, unknown>;
  const accel = (x: unknown): string => (typeof x === 'string' && ACCEL.test(x) ? x : '');
  const workspaces: MenuWorkspace[] = [];
  if (Array.isArray(r['workspaces'])) {
    for (const w of r['workspaces'].slice(0, MENU_WORKSPACES_MAX)) {
      if (typeof w !== 'object' || w === null) continue;
      const { id, name } = w as Record<string, unknown>;
      if (typeof id !== 'string' || !id || id.length > 64 || typeof name !== 'string') continue;
      workspaces.push({ id, name: name.slice(0, 100) || id });
    }
  }
  const active = r['activeWorkspaceId'];
  return {
    signedIn: bool(r['signedIn']),
    voice: {
      inRoom: bool(vo['inRoom']),
      muted: bool(vo['muted']),
      deafened: bool(vo['deafened']),
      camera: bool(vo['camera']),
      canCamera: bool(vo['canCamera']),
      streaming: bool(vo['streaming']),
      canStream: bool(vo['canStream']),
    },
    workspaces,
    activeWorkspaceId: typeof active === 'string' && active.length <= 64 ? active : null,
    canCreateRoom: bool(r['canCreateRoom']),
    canInvite: bool(r['canInvite']),
    hotkeys: { search: accel(hk['search']), mute: accel(hk['mute']), deafen: accel(hk['deafen']) },
  };
}

/** A command id from main (IPC input to the renderer): a known action or `workspace:<id>`. */
export function isMenuAction(v: unknown): v is MenuAction {
  if (typeof v !== 'string') return false;
  return (MENU_ACTIONS as readonly string[]).includes(v) || /^workspace:.{1,64}$/.test(v);
}
