import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const retryFailedLoads = vi.fn(() => Promise.resolve());
const retryFailedBoardLoads = vi.fn();
const refetchQueries = vi.fn(() => Promise.resolve());
vi.mock('./chat', () => ({ retryFailedLoads }));
vi.mock('./boards', () => ({ retryFailedBoardLoads }));
vi.mock('../lib/queryClient', () => ({ queryClient: { refetchQueries } }));

const { onApiTransportReset, API_RESET_RETRY_MS } = await import('./apiReset');

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('onApiTransportReset (docs/09 #146)', () => {
  it('reloads failed rooms, boards / the open task and failed queries once the killed requests have failed', async () => {
    onApiTransportReset();
    await vi.advanceTimersByTimeAsync(API_RESET_RETRY_MS - 1);
    expect(retryFailedLoads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(retryFailedLoads).toHaveBeenCalledTimes(1);
    expect(retryFailedBoardLoads).toHaveBeenCalledTimes(1);
    expect(refetchQueries).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0); // nothing keeps running afterwards
  });

  it('back-to-back resets retry once', async () => {
    onApiTransportReset();
    await vi.advanceTimersByTimeAsync(500);
    onApiTransportReset();
    await vi.advanceTimersByTimeAsync(API_RESET_RETRY_MS);
    expect(retryFailedLoads).toHaveBeenCalledTimes(1);
  });
});
