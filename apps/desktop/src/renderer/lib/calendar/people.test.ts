import { describe, expect, it } from 'vitest';
import { MAX_PEOPLE, PERSON_COLORS, addPeople, peopleReducer, personColor } from './people';

describe('«Люди» filter reducer', () => {
  it('adds without repeats and keeps the order', () => {
    let s = peopleReducer({}, { type: 'add', workspaceId: 'w', ids: ['a', 'b'] });
    s = peopleReducer(s, { type: 'add', workspaceId: 'w', ids: ['b', 'c'] });
    expect(s).toEqual({ w: ['a', 'b', 'c'] });
  });

  it('removes one, clears the workspace entry when empty, leaves other workspaces', () => {
    let s = peopleReducer({ w: ['a', 'b'], x: ['z'] }, { type: 'remove', workspaceId: 'w', id: 'a' });
    expect(s).toEqual({ w: ['b'], x: ['z'] });
    s = peopleReducer(s, { type: 'remove', workspaceId: 'w', id: 'b' });
    expect(s).toEqual({ x: ['z'] });
    expect(peopleReducer(s, { type: 'clear', workspaceId: 'x' })).toEqual({});
  });

  it('returns the same state when nothing changes (no store write, no re-render)', () => {
    const s = { w: ['a'] };
    expect(peopleReducer(s, { type: 'add', workspaceId: 'w', ids: ['a'] })).toBe(s);
    expect(peopleReducer(s, { type: 'remove', workspaceId: 'w', id: 'q' })).toBe(s);
    expect(peopleReducer({}, { type: 'clear', workspaceId: 'w' })).toEqual({});
  });

  it('caps at 20 people (the free / busy limit)', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `u${i}`);
    const r = addPeople([], ids);
    expect(r.list).toHaveLength(MAX_PEOPLE);
    expect(r.capped).toBe(true);
    expect(peopleReducer({}, { type: 'set', workspaceId: 'w', ids })['w']).toHaveLength(MAX_PEOPLE);
  });

  it('gives each position a colour, cycling', () => {
    expect(personColor(0)).toBe(PERSON_COLORS[0]);
    expect(personColor(PERSON_COLORS.length)).toBe(PERSON_COLORS[0]);
    expect(personColor(1)).not.toBe(personColor(0));
  });
});
