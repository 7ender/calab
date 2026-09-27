import { create } from '@bufbuild/protobuf';
import { InviteLookupResponseSchema, UserSchema, type InviteLookupResponse } from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { EmailLookup, LOOKUP_DEBOUNCE_MS, type LookupState } from './emailLookup';

vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() } }));

const found = (member = false): InviteLookupResponse =>
  create(InviteLookupResponseSchema, { user: create(UserSchema, { id: 'u1', displayName: 'Егор' }), member });

describe('EmailLookup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(answer: (email: string, signal: AbortSignal) => Promise<InviteLookupResponse>) {
    const states: LookupState[] = [];
    const lookup = vi.fn(answer);
    const l = new EmailLookup({ lookup, onChange: (s) => states.push(s) });
    return { l, lookup, states };
  }

  it('looks up only a valid email, 400 ms after the last keystroke', async () => {
    const { l, lookup } = setup(() => Promise.resolve(found()));
    l.input('egor');
    l.input('egor@example');
    expect(l.state.kind).toBe('typing');
    l.input('egor@example.com');
    expect(l.state.kind).toBe('searching');
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS - 1);
    expect(lookup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]?.[0]).toBe('egor@example.com');
    expect(l.state).toMatchObject({ kind: 'found', member: false, user: { displayName: 'Егор' } });
  });

  it('typing within the pause restarts it: one request for the final address', async () => {
    const { l, lookup } = setup(() => Promise.resolve(found()));
    l.input('a@b.co');
    await vi.advanceTimersByTimeAsync(300);
    l.input('a@b.com');
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]?.[0]).toBe('a@b.com');
  });

  it('no account → «none»; a member → found with member', async () => {
    const none = setup(() => Promise.resolve(create(InviteLookupResponseSchema, {})));
    none.l.input('new@example.com');
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    expect(none.l.state).toEqual({ kind: 'none', email: 'new@example.com' });

    const member = setup(() => Promise.resolve(found(true)));
    member.l.input('vera@example.com');
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    expect(member.l.state).toMatchObject({ kind: 'found', member: true });
  });

  it('a newer input aborts the request in flight: the late answer is dropped', async () => {
    let release: (r: InviteLookupResponse) => void = () => undefined;
    const signals: AbortSignal[] = [];
    const { l } = setup(
      (_e, signal) =>
        new Promise((res) => {
          signals.push(signal);
          release = res;
        }),
    );
    l.input('first@example.com');
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    l.input('');
    expect(signals[0]?.aborted).toBe(true);
    release(found());
    await vi.advanceTimersByTimeAsync(0);
    expect(l.state.kind).toBe('idle');
  });

  it('an error becomes a human text', async () => {
    const { l } = setup(() => Promise.reject(new ApiError('ERROR_CODE_EMAIL_NOT_VERIFIED', 'x', 403)));
    l.input('x@example.com');
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    expect(l.state).toEqual({ kind: 'error', email: 'x@example.com', text: 'Сначала подтвердите почту' });
  });
});
