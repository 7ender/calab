import { beforeEach, describe, expect, it } from 'vitest';
import { useTyping } from './typing';

describe('typing store', () => {
  beforeEach(() => useTyping.getState().reset());

  it('sets and refreshes an entry per room and user', () => {
    const s = useTyping.getState();
    s.set('r1', 'u1', 1000);
    s.set('r1', 'u2', 1500);
    s.set('r1', 'u1', 2000);
    expect(useTyping.getState().rooms).toEqual({ r1: { u1: 2000, u2: 1500 } });
  });

  it('expire drops only entries that were not refreshed', () => {
    const s = useTyping.getState();
    s.set('r1', 'u1', 1000);
    s.set('r1', 'u2', 3000);
    s.expire('r1', 'u1', 1500);
    s.expire('r1', 'u2', 1500);
    expect(useTyping.getState().rooms['r1']).toEqual({ u2: 3000 });
  });

  it('no-op updates keep the state object (no re-render)', () => {
    const before = useTyping.getState().rooms;
    useTyping.getState().clear('r1', 'nobody');
    useTyping.getState().expire('r1', 'nobody');
    expect(useTyping.getState().rooms).toBe(before);
  });

  it('clear removes an entry; reset empties everything', () => {
    const s = useTyping.getState();
    s.set('r1', 'u1', 1000);
    s.set('r2', 'u1', 1000);
    s.clear('r1', 'u1');
    expect(useTyping.getState().rooms['r1']).toEqual({});
    s.reset();
    expect(useTyping.getState().rooms).toEqual({});
  });
});
