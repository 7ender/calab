import { describe, expect, it } from 'vitest';
import { notifyStepView, readNotifyState, requestNotify } from './notifyPermission';

describe('notification permission (onboarding)', () => {
  it('maps every state to what the step shows; default is never shown as denied', () => {
    expect(notifyStepView('default')).toEqual({ note: null, primary: 'enable', later: true });
    expect(notifyStepView('granted')).toEqual({ note: 'granted', primary: 'continue', later: false });
    expect(notifyStepView('denied')).toEqual({ note: 'denied', primary: 'continue-without', later: false });
    expect(notifyStepView('unsupported')).toEqual({ note: 'unsupported', primary: 'continue', later: false });
  });

  it('reads the state; no API → unsupported', () => {
    expect(readNotifyState(undefined)).toBe('unsupported');
    expect(readNotifyState({ permission: 'default' })).toBe('unsupported'); // no requestPermission
    expect(readNotifyState({ permission: 'default', requestPermission: () => Promise.resolve('default') })).toBe('default');
    expect(readNotifyState({ permission: 'granted', requestPermission: () => Promise.resolve('granted') })).toBe('granted');
  });

  it('asks with the promise API, the callback API, and survives a throwing one', async () => {
    await expect(requestNotify({ permission: 'default', requestPermission: () => Promise.resolve('granted') })).resolves.toBe('granted');
    await expect(requestNotify({ permission: 'default', requestPermission: () => Promise.resolve('denied') })).resolves.toBe('denied');
    // Old Safari: callback only, returns undefined.
    await expect(
      requestNotify({
        permission: 'default',
        requestPermission: (cb) => {
          cb?.('granted');
          return undefined;
        },
      }),
    ).resolves.toBe('granted');
    await expect(
      requestNotify({
        permission: 'default',
        requestPermission: () => {
          throw new Error('not allowed');
        },
      }),
    ).resolves.toBe('default');
    await expect(requestNotify(undefined)).resolves.toBe('unsupported');
  });
});
