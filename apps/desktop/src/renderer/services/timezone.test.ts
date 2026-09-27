import type { Me } from '@calaba/protocol';
import { describe, expect, it, vi } from 'vitest';

const update = vi.fn((_: { timezone: string }) => Promise.resolve({}));
vi.mock('../platform', () => ({ platform: { kind: 'electron', app: { log: () => undefined } } }));
vi.mock('../lib/api/endpoints', () => ({ api: { me: { update: (b: { timezone: string }) => update(b) } } }));
vi.mock('../lib/timezone', async (orig) => ({ ...(await orig<typeof import('../lib/timezone')>()), localTimeZone: () => zone }));

let zone = 'Asia/Yekaterinburg';
const { syncTimeZone, recheckTimeZone, resetTimeZoneSync } = await import('./timezone');
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

  it('re-check (wake-up / daily): sends only a zone not yet checked, nothing when signed out', () => {
    update.mockClear();
    resetTimeZoneSync();
    recheckTimeZone(); // signed out
    expect(update).not.toHaveBeenCalled();
    syncTimeZone(me('a'));
    expect(update).toHaveBeenCalledTimes(1);
    recheckTimeZone(); // same device zone: no repeat (a 422 is not retried either)
    expect(update).toHaveBeenCalledTimes(1);
    zone = 'Asia/Tokyo'; // flew to Tokyo
    recheckTimeZone();
    expect(update).toHaveBeenLastCalledWith({ timezone: 'Asia/Tokyo' });
    expect(update).toHaveBeenCalledTimes(2);
    zone = 'Asia/Yekaterinburg';
    resetTimeZoneSync();
  });

  it('skips the request when the profile already has this zone', () => {
    update.mockClear();
    resetTimeZoneSync();
    syncTimeZone(me('a', 'Asia/Yekaterinburg'));
    expect(update).not.toHaveBeenCalled();
  });
});
