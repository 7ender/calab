import { describe, expect, it } from 'vitest';
import { keyAction, rowActions } from './quickSwitcherActions';

const none = { shiftKey: false, metaKey: false, ctrlKey: false };
const voice = { kind: 'room', voice: true, canConnect: true } as const;

describe('rowActions', () => {
  it('a voice room: join first, then its chat', () => {
    expect(rowActions(voice)).toEqual(['join', 'chat']);
  });
  it('a voice room without CONNECT only opens its chat', () => {
    expect(rowActions({ ...voice, canConnect: false })).toEqual(['chat']);
  });
  it('text rooms, DMs, members and messages: one «Open»', () => {
    for (const kind of ['room', 'dm', 'member', 'message'] as const) expect(rowActions({ kind })).toEqual(['open']);
  });
});

describe('keyAction', () => {
  it('Enter joins a voice room, ⇧Enter / ⌘Enter / Ctrl+Enter open its chat', () => {
    expect(keyAction(voice, none)).toBe('join');
    expect(keyAction(voice, { ...none, shiftKey: true })).toBe('chat');
    expect(keyAction(voice, { ...none, metaKey: true })).toBe('chat');
    expect(keyAction(voice, { ...none, ctrlKey: true })).toBe('chat');
  });
  it('rows with one action ignore the modifier', () => {
    expect(keyAction({ kind: 'room' }, none)).toBe('open');
    expect(keyAction({ kind: 'room' }, { ...none, shiftKey: true })).toBe('open');
    expect(keyAction({ kind: 'dm' }, { ...none, metaKey: true })).toBe('open');
    expect(keyAction({ ...voice, canConnect: false }, none)).toBe('chat');
    expect(keyAction({ ...voice, canConnect: false }, { ...none, shiftKey: true })).toBe('chat');
  });
});
