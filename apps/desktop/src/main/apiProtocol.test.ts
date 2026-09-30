import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
let handler: ((req: Request) => Promise<Response>) | undefined;

vi.mock('electron', () => ({
  net: { fetch: (url: string, init: RequestInit) => fetchMock(url, init) },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: (_scheme: string, h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
  },
}));

vi.mock('./auth', () => ({
  currentServerUrl: () => 'https://api.calab.test',
  getAccessToken: vi.fn(() => Promise.resolve('token')),
  forceRefresh: vi.fn(() => Promise.resolve(null)),
}));

const warn = vi.fn();
vi.mock('./logging', () => ({ log: { warn, info: vi.fn(), error: vi.fn() } }));

// Imported after the mocks above (docs/12 "net.fetch has no timeout").
const { handleApiScheme, deadlinesFor, HEADERS_TIMEOUT_MS, IDLE_TIMEOUT_MS, SLOW_REQUEST_MS } = await import('./apiProtocol');

function apiRequest(path: string, init?: RequestInit): Request {
  return new Request(`calaba-api://api${path}`, init);
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  warn.mockReset();
  handler = undefined;
  handleApiScheme();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handleApiScheme deadlines', () => {
  it('a dead connection (net.fetch never resolves) times out at 504 within the headers deadline', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          });
        }),
    );
    const pending = handler?.(apiRequest('/api/messages'));
    await vi.advanceTimersByTimeAsync(HEADERS_TIMEOUT_MS);
    const res = await pending;
    expect(res?.status).toBe(504);
    expect(((await res?.json()) as { code?: string }).code).toBe('ERROR_CODE_UNAVAILABLE');
    expect(warn).toHaveBeenCalledWith('api request timeout GET /api/messages');
  });

  it('a body that stalls mid-stream is aborted with 504 after the idle timeout', async () => {
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
          resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }),
    );
    const pending = handler?.(apiRequest('/api/messages'));
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    const res = await pending;
    expect(res?.status).toBe(504);
    expect(warn).toHaveBeenCalledWith('api request timeout GET /api/messages');
  });

  it('a normal response passes through unchanged', async () => {
    fetchMock.mockImplementation(
      () => new Promise((resolve) => resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))),
    );
    const res = await handler?.(apiRequest('/api/messages'));
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('deadlines', () => {
  it('the SIP connection test (a real call, ~25 s) waits longer; everything else keeps the defaults', () => {
    expect(deadlinesFor('/api/workspaces/w1/sip/test')).toEqual({ headers: SLOW_REQUEST_MS, idle: SLOW_REQUEST_MS });
    expect(SLOW_REQUEST_MS).toBeGreaterThan(25_000);
    expect(deadlinesFor('/api/workspaces/w1/sip')).toEqual({ headers: HEADERS_TIMEOUT_MS, idle: IDLE_TIMEOUT_MS });
    expect(deadlinesFor('/api/workspaces/w1/sip/test/x')).toEqual({ headers: HEADERS_TIMEOUT_MS, idle: IDLE_TIMEOUT_MS });
  });
});
