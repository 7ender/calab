import { describe, expect, it, vi } from 'vitest';

// strings.ts imports only the shared contract; keep electron out of this pure test anyway.
vi.mock('electron', () => ({}));

import { MAIN_STRING_KEYS } from '../shared/ipc';
import { EMPTY_MENU_STATE, isMenuAction, parseMenuState, type MenuState } from '../shared/menu';
import { buildAppMenu, buildDockMenu, commandItems, type MenuItemModel } from './menuModel';
import { mainStrings } from './strings';

const s = mainStrings();
const env = { dev: false, appName: 'Calab' };

const state = (patch: Partial<MenuState> = {}): MenuState => ({
  ...EMPTY_MENU_STATE,
  signedIn: true,
  workspaces: [
    { id: 'w1', name: 'Alpha' },
    { id: 'w2', name: 'Beta' },
  ],
  activeWorkspaceId: 'w2',
  hotkeys: { search: 'Command+K', mute: 'Command+Shift+M', deafen: 'Command+Shift+D' },
  ...patch,
});

const find = (items: MenuItemModel[], command: string) => commandItems(items).find((i) => i.command === command);
const titles = (items: MenuItemModel[]): string[] => items.map((i) => (i.kind === 'submenu' ? i.label : ''));

describe('macOS menu model', () => {
  it('has the app, File, Edit, View, Voice, Window and Help menus in the app language', () => {
    expect(titles(buildAppMenu(s, state(), env))).toEqual(['Calab', 'Файл', 'Правка', 'Вид', 'Голос', 'Окно', 'Справка']);
    const en = { ...s, menuFile: 'File', menuNewMessage: 'New message…' };
    const m = buildAppMenu(en, state(), env);
    expect(titles(m)[1]).toBe('File');
    expect(find(m, 'new-message')?.label).toBe('New message…');
  });

  it('every label comes from the pushed strings (MAIN_STRING_KEYS covers the menu)', () => {
    for (const k of Object.keys(s)) expect(MAIN_STRING_KEYS).toContain(k);
    const labels = commandItems(buildAppMenu(s, state(), env)).map((i) => i.label);
    expect(labels).toContain('Новое сообщение…');
    expect(labels).toContain('Эмодзи и символы');
  });

  it('shows the rebindable shortcuts as pushed by the renderer, and the fixed menu keys', () => {
    const m = buildAppMenu(s, state({ hotkeys: { search: 'Command+P', mute: 'Command+Shift+M', deafen: '' } }), env);
    expect(find(m, 'search')?.accelerator).toBe('Command+P');
    expect(find(m, 'toggle-mute')?.accelerator).toBe('Command+Shift+M');
    expect(find(m, 'toggle-deafen')?.accelerator).toBeUndefined();
    expect(find(m, 'new-message')?.accelerator).toBe('CommandOrControl+N');
    expect(find(m, 'settings')?.accelerator).toBe('CommandOrControl+,');
    // «Участники» has no key: ⌘⇧M is the mute shortcut.
    expect(find(m, 'members')?.accelerator).toBeUndefined();
  });

  it('voice items are enabled only in a room; checkboxes follow mute / deafen / camera / stream', () => {
    const out = buildAppMenu(s, state(), env);
    for (const c of ['toggle-mute', 'toggle-deafen', 'toggle-camera', 'share-screen', 'leave-voice']) expect(find(out, c)?.enabled).toBe(false);
    const voice = { inRoom: true, muted: true, deafened: false, camera: true, canCamera: true, streaming: false, canStream: false };
    const inRoom = buildAppMenu(s, state({ voice }), env);
    expect(find(inRoom, 'toggle-mute')).toMatchObject({ enabled: true, check: { type: 'checkbox', checked: true } });
    expect(find(inRoom, 'toggle-deafen')).toMatchObject({ enabled: true, check: { checked: false } });
    expect(find(inRoom, 'toggle-camera')).toMatchObject({ enabled: true, check: { checked: true } });
    expect(find(inRoom, 'share-screen')?.enabled).toBe(false);
    expect(find(inRoom, 'leave-voice')?.enabled).toBe(true);
  });

  it('room-create / invite follow the capabilities; signed out disables the app items', () => {
    const m = buildAppMenu(s, state({ canCreateRoom: true }), env);
    expect(find(m, 'room-create')?.enabled).toBe(true);
    expect(find(m, 'invite')?.enabled).toBe(false);
    const anon = buildAppMenu(s, { ...EMPTY_MENU_STATE }, env);
    for (const c of ['new-message', 'search', 'members', 'dms']) expect(find(anon, c)?.enabled).toBe(false);
    expect(find(anon, 'settings')?.enabled).toBe(true);
    expect(commandItems(anon).some((i) => i.command.startsWith('workspace:'))).toBe(false);
  });

  it('lists workspaces with ⌘1…⌘9 and a radio mark on the open one', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `w${i}`, name: `WS ${i}` }));
    const m = buildAppMenu(s, state({ workspaces: many, activeWorkspaceId: 'w3' }), env);
    const ws = commandItems(m).filter((i) => i.command.startsWith('workspace:'));
    expect(ws).toHaveLength(11);
    expect(ws[0]?.accelerator).toBe('CommandOrControl+1');
    expect(ws[8]?.accelerator).toBe('CommandOrControl+9');
    expect(ws[9]?.accelerator).toBeUndefined();
    expect(ws.filter((i) => i.check?.checked).map((i) => i.command)).toEqual(['workspace:w3']);
    expect(ws.every((i) => i.check?.type === 'radio')).toBe(true);
  });

  it('«Разработка» only when not packaged', () => {
    const view = (dev: boolean) => buildAppMenu(s, state(), { ...env, dev }).find((i) => i.kind === 'submenu' && i.label === 'Вид');
    const has = (dev: boolean) => JSON.stringify(view(dev)).includes('toggleDevTools');
    expect(has(false)).toBe(false);
    expect(has(true)).toBe(true);
  });

  it('Dock menu: new message, mute while in voice, workspaces', () => {
    expect(buildDockMenu(s, EMPTY_MENU_STATE)).toEqual([]);
    const out = commandItems(buildDockMenu(s, state())).map((i) => i.command);
    expect(out).toEqual(['new-message', 'workspace:w1', 'workspace:w2']);
    const voice = { ...EMPTY_MENU_STATE.voice, inRoom: true, muted: true };
    const d = commandItems(buildDockMenu(s, state({ voice })));
    expect(d.map((i) => i.command)).toEqual(['new-message', 'toggle-mute', 'workspace:w1', 'workspace:w2']);
    expect(d[1]?.check?.checked).toBe(true);
  });
});

describe('menu IPC validation', () => {
  it('parseMenuState drops junk and keeps valid fields', () => {
    expect(parseMenuState(null)).toEqual(EMPTY_MENU_STATE);
    const p = parseMenuState({
      signedIn: true,
      voice: { inRoom: 1, muted: true },
      workspaces: [{ id: 'a', name: 'A' }, { id: '', name: 'x' }, 'junk', { id: 'b', name: 5 }],
      activeWorkspaceId: 'a',
      canCreateRoom: 'yes',
      hotkeys: { search: 'Command+K', mute: 'rm -rf /; <script>', deafen: 7 },
    });
    expect(p.signedIn).toBe(true);
    expect(p.voice).toMatchObject({ inRoom: false, muted: true });
    expect(p.workspaces).toEqual([{ id: 'a', name: 'A' }]);
    expect(p.canCreateRoom).toBe(false);
    expect(p.hotkeys).toEqual({ search: 'Command+K', mute: '', deafen: '' });
    expect(parseMenuState({ workspaces: Array.from({ length: 80 }, (_, i) => ({ id: `w${i}`, name: 'n' })) }).workspaces).toHaveLength(50);
  });

  it('isMenuAction accepts known ids and workspace:<id> only', () => {
    expect(isMenuAction('toggle-mute')).toBe(true);
    expect(isMenuAction('workspace:abc')).toBe(true);
    expect(isMenuAction('workspace:')).toBe(false);
    expect(isMenuAction('check-updates')).toBe(false);
    expect(isMenuAction(42)).toBe(false);
  });
});
