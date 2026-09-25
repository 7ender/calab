import { create } from '@bufbuild/protobuf';
import { MessageSchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { useMessages } from './messages';

const msg = (id: string, nonce = '', content = id) => create(MessageSchema, { id, roomId: 'r', authorId: 'u', content, nonce });
const keys = (): string[] => useMessages.getState().rooms['r']?.items.map((c) => c.key) ?? [];

beforeEach(() => {
  useMessages.getState().reset();
  useMessages.getState().prependPage('r', [msg('0002'), msg('0001')], true); // API: newest first
});

describe('messages store', () => {
  it('pages are stored oldest-first and prepending older pages dedupes', () => {
    expect(keys()).toEqual(['0001', '0002']);
    useMessages.getState().prependPage('r', [msg('0001'), msg('0000')], false);
    expect(keys()).toEqual(['0000', '0001', '0002']);
    expect(useMessages.getState().rooms['r']?.hasMoreBefore).toBe(false);
  });

  it('server echo replaces the optimistic message by nonce (no duplicate)', () => {
    const s = useMessages.getState();
    s.addPending('r', { key: 'local:n1', msg: msg('', 'n1', 'hi'), status: 'pending' });
    expect(keys()).toEqual(['0001', '0002', 'local:n1']);
    s.upsert(msg('0003', 'n1', 'hi')); // POST response or MESSAGE_CREATE, whichever first
    s.upsert(msg('0003', 'n1', 'hi')); // the other one
    expect(keys()).toEqual(['0001', '0002', '0003']);
    expect(useMessages.getState().rooms['r']?.items[2]?.status).toBe('sent');
  });

  it('messages from others land before my still-pending ones', () => {
    const s = useMessages.getState();
    s.addPending('r', { key: 'local:n2', msg: msg('', 'n2'), status: 'pending' });
    s.upsert(msg('0005'));
    expect(keys()).toEqual(['0001', '0002', '0005', 'local:n2']);
  });

  it('out-of-order delivery is sorted by id; edits replace in place; delete removes', () => {
    const s = useMessages.getState();
    s.upsert(msg('0004'));
    s.upsert(msg('0003'));
    expect(keys()).toEqual(['0001', '0002', '0003', '0004']);
    s.upsert(msg('0003', '', 'edited'));
    expect(useMessages.getState().rooms['r']?.items.find((c) => c.key === '0003')?.msg.content).toBe('edited');
    s.remove('r', '0003');
    expect(keys()).toEqual(['0001', '0002', '0004']);
  });

  it('events for rooms that are not loaded are ignored (fetched fresh on open)', () => {
    useMessages.getState().upsert(create(MessageSchema, { id: '9', roomId: 'other' }));
    expect(useMessages.getState().rooms['other']).toBeUndefined();
  });
});
