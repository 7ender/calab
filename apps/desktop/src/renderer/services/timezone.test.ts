import type { Me } from '@calaba/protocol';
import { describe, expect, it, vi } from 'vitest';

const update = vi.fn((_: { timezone: string }) => Promise.resolve({}));
vi.mock('../platform', () => ({ platform: { kind: 'electron', app: { log: () => undefined } } }));
vi.mock('../lib/api/endpoints', () => ({ api: { me: { update: (b: { timezone: string }) => update(b) } } }));
vi.mock('../lib/timezone', async (orig) => ({ ...(await orig<typeof import('../lib/timezone')>()), localTimeZone: () => 'Asia/Yekaterinburg' }));

const { syncTimeZone, resetTimeZoneSync } = await import('./timezone');
const me = (id: string, timezone = ''): Me => ({ user: { id, timezone } }) as unknown as Me;

describe('syncTimeZone', () => {
  it('sends the zone once per sign-in, again for another account and after sign-out', () => {
    update.mockClear();
    resetTimeZoneSync();
    syncTimeZone(me('a'));
    syncTimeZone(me('a')); // a second READY (gateway reconnect): no repeat, even after a 422
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith({ timezone: 'Asia/Yekaterinburg' });
    syncTimeZone(me('b')); // switched account without a full sign-out path
    expect(update).toHaveBeenCalledTimes(2);
    resetTimeZoneSync(); // sign-out
    syncTimeZone(me('a'));
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('skips the request when the profile already has this zone', () => {
    update.mockClear();
    resetTimeZoneSync();
    syncTimeZone(me('a', 'Asia/Yekaterinburg'));
    expect(update).not.toHaveBeenCalled();
  });
});
