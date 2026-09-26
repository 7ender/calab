import { QueryClient } from '@tanstack/react-query';

/** The app-wide react-query cache (cleared on logout: no data of the previous account leaks). */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } },
});
