import { queryClient } from '../lib/queryClient';
import { retryFailedBoardLoads } from './boards';
import { retryFailedLoads } from './chat';

/**
 * Main closed the API connections after a stall or a wake (docs/09 #146, main/apiTransport.ts).
 * Requests that were in flight on them fail right after the reset, so the retry waits a moment
 * for them to land in the error state, then reloads everything left there — no «Повторить» click.
 * One-shot timer per reset, nothing runs otherwise.
 */
export const API_RESET_RETRY_MS = 1_500;

let timer: ReturnType<typeof setTimeout> | undefined;

export function onApiTransportReset(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void retryFailedLoads();
    retryFailedBoardLoads();
    void queryClient.refetchQueries({ type: 'active', predicate: (q) => q.state.status === 'error' });
  }, API_RESET_RETRY_MS);
}
