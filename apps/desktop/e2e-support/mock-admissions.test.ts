import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { GatewayFrameSchema, GatewayOpcode, type DispatchEvent, type GatewayFrame } from '@calaba/protocol';
import WebSocket from 'ws';
import { IDS, startMockServer, type MockServer } from './mock-server';

// Guest admission in the mock (ADR-0040): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

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
  return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
}

const api = (token: string, path: string, init: { method?: string; body?: string } = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });

/** An identified gateway session collecting DISPATCH events; `next(pred)` waits for one. */
async function gateway(token: string): Promise<{ ready: DispatchEvent; next(pred: (e: DispatchEvent) => boolean): Promise<DispatchEvent>; close(): void }> {
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/gateway?v=1`);
  const events: DispatchEvent[] = [];
  const waiters: { pred: (e: DispatchEvent) => boolean; resolve: (e: DispatchEvent) => void }[] = [];
  ws.on('message', (data: Buffer) => {
    const f: GatewayFrame = fromBinary(GatewayFrameSchema, new Uint8Array(data));
    if (f.payload.case !== 'dispatch') return;
    const e = f.payload.value;
    const w = waiters.findIndex((x) => x.pred(e));
    if (w >= 0) waiters.splice(w, 1)[0]?.resolve(e);
    else events.push(e);
  });
  const next = (pred: (e: DispatchEvent) => boolean): Promise<DispatchEvent> => {
    const i = events.findIndex(pred);
    if (i >= 0) return Promise.resolve(events.splice(i, 1)[0] as DispatchEvent);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting for an event')), 5000);
    });
  };
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, { op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } })));
  const ready = await next((e) => e.event.case === 'ready');
  return { ready, next, close: () => ws.close() };
}

describe('guest admission (ADR-0040)', () => {
  it('a guest knocks by a link, waits without the room and is admitted', async () => {
    server.reset();
    const anna = await login();
    const room = IDS.rooms.call;
    const patched = await api(anna, `/api/rooms/${room}`, { method: 'PATCH', body: JSON.stringify({ guestApproval: true }) });
    expect(((await patched.json()) as { room: { guestApproval?: boolean } }).room.guestApproval).toBe(true);
    const preview = (await (await api('', '/api/room-invites/call-guest-link')).json()) as { requiresApproval?: boolean };
    expect(preview.requiresApproval).toBe(true);
    const annaGw = await gateway(anna);

    const joined = await api('', '/api/room-invites/call-guest-link/join', { method: 'POST', body: JSON.stringify({ nickname: 'Гость Петя' }) });
    expect(joined.status).toBe(201);
    const j = (await joined.json()) as { tokens: { accessToken: string }; me: { user: { id: string } }; admission?: { status: string; roomName: string } };
    expect(j.admission?.status).toBe('ROOM_ADMISSION_STATUS_PENDING');
    expect(j.admission?.roomName).toBe('Созвон');
    const guestId = j.me.user.id;
    const req = await annaGw.next((e) => e.event.case === 'roomAdmissionRequest');
    expect(req.event.case === 'roomAdmissionRequest' && req.event.value.admission?.user?.displayName).toBe('Гость Петя');

    const guestGw = await gateway(j.tokens.accessToken);
    const ready = guestGw.ready.event.case === 'ready' ? guestGw.ready.event.value : undefined;
    expect(ready?.pendingAdmissions.map((a) => a.roomId)).toEqual([room]);
    // Fixture rooms open to the guest role stay visible; the knocked room is not.
    expect(ready?.workspaces.find((w) => w.workspace?.id === IDS.workspaces.main)?.rooms.map((r) => r.id)).not.toContain(room);
    expect((await api(j.tokens.accessToken, `/api/rooms/${room}/messages`)).status).toBe(404);

    const list = (await (await api(anna, `/api/rooms/${room}/admissions`)).json()) as { admissions: { user: { id: string } }[] };
    expect(list.admissions.map((a) => a.user.id)).toEqual([guestId]);
    const vera = await login('vera@calaba.test');
    expect((await api(vera, `/api/rooms/${room}/admissions/${guestId}`, { method: 'POST', body: JSON.stringify({ status: 'ROOM_ADMISSION_STATUS_ADMITTED' }) })).status).toBe(403);
    const long = 'я'.repeat(41);
    expect((await api(anna, `/api/rooms/${room}/admissions/${guestId}`, { method: 'POST', body: JSON.stringify({ status: 'ROOM_ADMISSION_STATUS_ADMITTED', displayName: long }) })).status).toBe(422);

    const decided = await api(anna, `/api/rooms/${room}/admissions/${guestId}`, {
      method: 'POST', body: JSON.stringify({ status: 'ROOM_ADMISSION_STATUS_ADMITTED', displayName: 'Пётр (подрядчик)' }),
    });
    expect(decided.status).toBe(200);
    const ev = await guestGw.next((e) => e.event.case === 'roomAdmissionDecided');
    expect(ev.event.case === 'roomAdmissionDecided' && ev.event.value.admission?.status).toBe(2); // ADMITTED
    await guestGw.next((e) => e.event.case === 'roomCreate' && e.event.value.room?.id === room);
    expect((await api(j.tokens.accessToken, `/api/rooms/${room}/messages`)).status).toBe(200);
    annaGw.close();
    guestGw.close();
  });

  it('decideAdmission: decline and no answer drop the membership; the guest may cancel', async () => {
    server.reset();
    const anna = await login();
    const annaGw = await gateway(anna);
    server.setGuestApproval(IDS.rooms.general, true);
    const a = server.knock(IDS.rooms.general, 'Незнакомец');
    await annaGw.next((e) => e.event.case === 'roomAdmissionRequest');
    server.decideAdmission(IDS.rooms.general, a, 'no_answer');
    const d = await annaGw.next((e) => e.event.case === 'roomAdmissionDecided');
    expect(d.event.case === 'roomAdmissionDecided' && d.event.value.admission?.noAnswer).toBe(true);
    await annaGw.next((e) => e.event.case === 'workspaceMemberRemove' && e.event.value.userId === a);

    const b = server.knock(IDS.rooms.general, 'Другой');
    server.decideAdmission(IDS.rooms.general, b, 'declined');
    await annaGw.next((e) => e.event.case === 'workspaceMemberRemove' && e.event.value.userId === b);
    expect(server.state.admissions.size).toBe(0);
    annaGw.close();
  });
});
