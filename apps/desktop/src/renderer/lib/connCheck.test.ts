import { describe, expect, it } from 'vitest';
import { candidateType, httpRow, iceRow, splitTurn, wsRow } from './connCheck';

describe('connection check verdicts (Settings → Соединение, 0.2.1)', () => {
  it('HTTP: API needs 2xx; RTC any answer is reachable; CSP and network errors fail', () => {
    expect(httpRow('api', { status: 200, ms: 31.4, error: null, cspBlocked: false })).toEqual({ id: 'api', status: 'pass', ms: 31, detail: null });
    expect(httpRow('api', { status: 502, ms: 10, error: null, cspBlocked: false })).toMatchObject({ status: 'fail', detail: 'Ответ HTTP 502' });
    expect(httpRow('rtcHttps', { status: 401, ms: 40, error: null, cspBlocked: false })).toMatchObject({ status: 'pass', ms: 40, detail: 'Ответ HTTP 401' });
    expect(httpRow('rtcHttps', { status: 0, ms: 40, error: null, cspBlocked: false })).toMatchObject({ status: 'pass', detail: 'Сервер ответил' });
    expect(httpRow('rtcHttps', { status: null, ms: 3, error: 'TypeError: Failed to fetch', cspBlocked: false })).toMatchObject({
      status: 'fail',
      ms: null,
      detail: 'TypeError: Failed to fetch',
    });
    expect(httpRow('rtcHttps', { status: null, ms: 3, error: 'TypeError: Failed to fetch', cspBlocked: true }).detail).toMatch(/политикой приложения/);
  });

  it('WSS: CSP (thrown SecurityError or report), open, token-less refusal, timeout', () => {
    const base = { thrown: null, opened: false, closeCode: null, ms: 55, timedOut: false, cspBlocked: false };
    const thrown = wsRow({ ...base, thrown: "SecurityError: Failed to construct 'WebSocket': Refused to connect" }, true);
    expect(thrown.status).toBe('fail');
    expect(thrown.detail).toMatch(/CSP/);
    expect(wsRow({ ...base, cspBlocked: true, closeCode: 1006 }, false).detail).toMatch(/CSP/);
    expect(wsRow({ ...base, opened: true }, false)).toMatchObject({ status: 'pass', ms: 55 });
    const refused = wsRow({ ...base, closeCode: 1006 }, true);
    expect(refused.status).toBe('pass');
    expect(refused.detail).toMatch(/1006/);
    expect(wsRow({ ...base, closeCode: 1006 }, false)).toMatchObject({ status: 'fail', detail: 'Соединение закрыто (код 1006)' });
    expect(wsRow({ ...base, timedOut: true }, true)).toMatchObject({ status: 'fail', detail: 'Нет ответа за 5 с' });
  });

  it('TURN: relay candidate passes; ICE error text; no data / no such server → skip', () => {
    expect(iceRow('turnUdp', 1, { relayMs: 120.6, errors: [], timedOut: false })).toMatchObject({ status: 'pass', ms: 121 });
    expect(iceRow('turnTls', 1, { relayMs: null, errors: [{ url: 'turns:turn.calab.ru:443', errorCode: 701, errorText: 'TURN allocate request timed out.' }], timedOut: true })).toMatchObject({
      status: 'fail',
      detail: '701 TURN allocate request timed out. (turns:turn.calab.ru:443)',
    });
    expect(iceRow('turnUdp', 1, { relayMs: null, errors: [], timedOut: true }).detail).toBe('Нет ответа за 8 с');
    expect(iceRow('turnUdp', 1, { relayMs: null, errors: [], timedOut: false }).detail).toBe('Нет кандидата relay');
    expect(iceRow('turnUdp', 0, { relayMs: null, errors: [], timedOut: false }).status).toBe('skip');
    const none = iceRow('turnTls', 1, null);
    expect(none.status).toBe('skip');
    expect(none.detail).toMatch(/подключитесь к голосу/);
  });

  it('splits LiveKit ICE servers by transport', () => {
    const { udp, tls } = splitTurn([
      { urls: ['turn:turn.calab.ru:443?transport=udp', 'turn:turn.calab.ru:3478', 'turn:turn.calab.ru:443?transport=tcp'], username: 'u', credential: 'c' },
      { urls: 'turns:turn.calab.ru:443?transport=tcp', username: 'u', credential: 'c' },
      { urls: ['stun:stun.l.google.com:19302'] },
    ]);
    expect(udp).toEqual([{ urls: ['turn:turn.calab.ru:443?transport=udp', 'turn:turn.calab.ru:3478'], username: 'u', credential: 'c' }]);
    expect(tls).toEqual([{ urls: ['turns:turn.calab.ru:443?transport=tcp'], username: 'u', credential: 'c' }]);
  });

  it('candidate type from the field or the candidate line', () => {
    expect(candidateType({ type: 'relay' })).toBe('relay');
    expect(candidateType({ candidate: 'candidate:1 1 udp 2 1.2.3.4 5 typ relay raddr 0.0.0.0 rport 0' })).toBe('relay');
    expect(candidateType({ candidate: 'candidate:1 1 udp 2 1.2.3.4 5 typ host' })).toBe('host');
    expect(candidateType(null)).toBeNull();
  });
});
