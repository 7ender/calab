import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { MessageKind, MessageSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/messages';
import { buildMetas, rowMeta, userColorIndex, type RowMeta } from './grouping';

const T0 = Date.parse('2026-01-14T09:00:00');
const at = (min: number): number => T0 + min * 60_000;
function m(id: string, author: string, ms: number, status: ChatMessage['status'] = 'sent'): ChatMessage {
  return { key: id, status, msg: create(MessageSchema, { id, roomId: 'r', authorId: author, createdAt: timestampFromMs(ms) }) };
}
const flags = (x: RowMeta): string => `${x.day ? 'D' : ''}${x.isNew ? 'N' : ''}${x.first ? 'F' : ''}${x.last ? 'L' : ''}`;

describe('grouping (Telegram: same author within 5 min)', () => {
  it('groups consecutive messages and marks first/last', () => {
    const items = [m('01', 'a', at(0)), m('02', 'a', at(1)), m('03', 'a', at(4.9)), m('04', 'b', at(5)), m('05', 'b', at(11))];
    expect(items.map((_, i) => flags(rowMeta(items, i, '', 'me')))).toEqual(['DF', '', 'L', 'FL', 'FL']);
  });

  it('a new day or the «new» marker breaks a group', () => {
    const items = [m('01', 'a', at(0)), m('02', 'a', at(1)), m('03', 'a', at(2)), m('04', 'a', at(24 * 60))];
    expect(items.map((_, i) => flags(rowMeta(items, i, '02', 'me')))).toEqual(['DF', 'L', 'NFL', 'DFL']);
  });

  it('a system card (ADR-0025) breaks the group of its author', () => {
    const sys = m('02', 'a', at(1));
    sys.msg.kind = MessageKind.SYSTEM;
    const items = [m('01', 'a', at(0)), sys, m('03', 'a', at(2))];
    expect(items.map((_, i) => flags(rowMeta(items, i, '', 'me')))).toEqual(['DFL', 'FL', 'FL']);
  });

  it('the «new» pill is never shown before my own message', () => {
    const items = [m('01', 'a', at(0)), m('02', 'me', at(1)), m('03', 'a', at(2))];
    expect(items.map((x, i) => rowMeta(items, i, '01', 'me').isNew)).toEqual([false, false, false]);
  });

  it('pending messages group with my previous ones', () => {
    const items = [m('01', 'me', at(0)), m('local:x', 'me', at(0.5), 'pending')];
    expect(items.map((_, i) => flags(rowMeta(items, i, '', 'me')))).toEqual(['DF', 'L']);
  });

  it('buildMetas reuses unchanged objects; a new message only touches its predecessor', () => {
    const cache = new Map<string, RowMeta>();
    const a = [m('01', 'a', at(0)), m('02', 'a', at(1))];
    const first = buildMetas(a, '', 'me', cache);
    const b = [...a, m('03', 'a', at(2))];
    const second = buildMetas(b, '', 'me', cache);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]); // was last, now in the middle
    expect(flags(second[2] as RowMeta)).toBe('L');
  });

  it('userColorIndex is stable and within the palette', () => {
    expect(userColorIndex('00000000-0000-7000-8001-000000000002')).toBe(userColorIndex('00000000-0000-7000-8001-000000000002'));
    for (const id of ['a', 'b', 'c', 'дина']) expect(userColorIndex(id)).toBeGreaterThanOrEqual(0);
    for (const id of ['a', 'b', 'c', 'дина']) expect(userColorIndex(id)).toBeLessThan(8);
  });
});
