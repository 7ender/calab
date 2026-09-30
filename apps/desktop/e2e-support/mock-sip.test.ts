import { SipCallStatus } from '@calaba/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDS, startMockServer, type MockServer } from './mock-server';
import { MOCK_SIP_RATE_NUMBER, MOCK_SIP_REFUSED_HOST, normalizeCallee, numberAllowed } from './mock-sip';

// Telephony in the mock (ADR-0046): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

let server: MockServer;

beforeAll(async () => {
  server = await startMockServer({ scenario: 'data' });
});
afterAll(async () => {
  await server.close();
});

async function login(email = 'owner@calaba.test'): Promise<string> {
  const res = await fetch(`${server.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', deviceName: 'vitest' }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
}

const api = (token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

const ws = `/api/workspaces/${IDS.workspaces.main}`;
const room = IDS.rooms.meeting;

describe('telephony (ADR-0046)', () => {
  it('normalises callees and checks prefixes like the server', () => {
    expect(normalizeCallee('8 (916) 123-45-67')).toBe('+79161234567');
    expect(normalizeCallee('9161234567')).toBeNull();
    expect(numberAllowed('+79161234567', ['+7'])).toBe(true);
    expect(numberAllowed('+442079460958', ['+7'])).toBe(false);
    expect(numberAllowed('+442079460958', [])).toBe(true);
  });

  it('settings: admin only, write-only password, 422 field, 502 provider error, sip_enabled follows', async () => {
    const anna = await login();
    const grigory = await login('grigory@calaba.test');
    expect((await api(grigory, `${ws}/sip`)).status).toBe(403);
    const empty = (await (await api(anna, `${ws}/sip`)).json()) as { settings: { enabled?: boolean } };
    expect(empty.settings.enabled ?? false).toBe(false);

    const bad = await api(anna, `${ws}/sip`, { method: 'PUT', body: { enabled: true, host: 'sip:x', callerId: '+74951234567' } });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { field: string }).field).toBe('host');

    const refused = await api(anna, `${ws}/sip`, { method: 'PUT', body: { enabled: true, host: MOCK_SIP_REFUSED_HOST, callerId: '+74951234567' } });
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { code: string }).code).toBe('ERROR_CODE_SIP_PROVIDER_ERROR');

    const put = await api(anna, `${ws}/sip`, { method: 'PUT', body: { enabled: true, host: 'sip.zadarma.com', callerId: '8 495 123-45-67', password: 'secret', allowedPrefixes: ['+7'] } });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as { settings: { hasPassword: boolean; callerId: string; trunkSaved: boolean; password?: string } };
    expect(saved.settings).toMatchObject({ hasPassword: true, callerId: '+74951234567', trunkSaved: true });
    expect(saved.settings.password).toBeUndefined();
    expect(server.state.workspaces.get(IDS.workspaces.main)?.sipEnabled).toBe(true);

    // Without the password field the stored one stays.
    const keep = await api(anna, `${ws}/sip`, { method: 'PUT', body: { enabled: true, host: 'sip.zadarma.com', callerId: '+74951234567', allowedPrefixes: ['+7'] } });
    expect(((await keep.json()) as { settings: { hasPassword: boolean } }).settings.hasPassword).toBe(true);

    const test = await api(anna, `${ws}/sip/test`, { method: 'POST' });
    expect(((await test.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('calls: in the call only, one live per room, allowed prefixes, rate limit, hang-up rules, journal', async () => {
    server.setSip(IDS.workspaces.main, { enabled: true });
    const anna = await login();


    // Not in the room's call yet.
    expect((await api(anna, `/api/rooms/${room}/calls`, { method: 'POST', body: { number: '+79161234567' } })).status).toBe(409);
    server.setVoiceState({ userId: IDS.users.anna, roomId: room });

    const notAllowed = await api(anna, `/api/rooms/${room}/calls`, { method: 'POST', body: { number: '+442079460958' } });
    expect(((await notAllowed.json()) as { code: string }).code).toBe('ERROR_CODE_SIP_NUMBER_NOT_ALLOWED');
    const rate = await api(anna, `/api/rooms/${room}/calls`, { method: 'POST', body: { number: MOCK_SIP_RATE_NUMBER } });
    expect(rate.status).toBe(429);
    expect(rate.headers.get('Retry-After')).toBe('600');

    const placed = await api(anna, `/api/rooms/${room}/calls`, { method: 'POST', body: { number: '8 916 123-45-67' } });
    expect(placed.status).toBe(201);
    const { call } = (await placed.json()) as { call: { id: string; status: string; number: string; participantIdentity: string } };
    expect(call).toMatchObject({ status: 'SIP_CALL_STATUS_DIALING', number: '+79161234567', participantIdentity: `sip:${call.id}` });

    const again = await api(anna, `/api/rooms/${room}/calls`, { method: 'POST', body: { number: '+79161234567' } });
    expect(((await again.json()) as { code: string }).code).toBe('ERROR_CODE_SIP_CALL_ACTIVE');

    server.setSipCallStatus(call.id, SipCallStatus.ACTIVE);
    // Someone else's call without MUTE_MEMBERS: 403.
    const member = await login('grigory@calaba.test');
    expect((await api(member, `/api/rooms/${room}/calls/${call.id}`, { method: 'DELETE' })).status).toBe(403);
    const hung = await api(anna, `/api/rooms/${room}/calls/${call.id}`, { method: 'DELETE' });
    expect(((await hung.json()) as { call: { status: string; reason: string } }).call).toMatchObject({ status: 'SIP_CALL_STATUS_ENDED', reason: 'hangup' });
    expect((await api(anna, `/api/rooms/${room}/calls/${call.id}`, { method: 'DELETE' })).status).toBe(409);

    const journal = (await (await api(anna, `${ws}/calls`)).json()) as { calls: { id: string }[]; nextCursor?: string };
    expect(journal.calls[0]?.id).toBe(call.id);
    expect(journal.nextCursor ?? '').toBe('');

    // Telephony off lays the live lines down.
    const id2 = server.placeSipCall(room, IDS.users.anna, '+79161234567');
    server.setSip(IDS.workspaces.main, null);
    expect(server.state.sipCalls.get(id2)).toMatchObject({ status: SipCallStatus.ENDED, reason: 'disabled' });
    expect(server.state.workspaces.get(IDS.workspaces.main)?.sipEnabled).toBe(false);
  });
});
