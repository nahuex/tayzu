/**
 * The app's TanStack Query client (design D4, TanStack Query settings): no retry on a
 * 4xx, at most one retry on a network failure or a 5xx, no refetch on window focus by
 * default, and nothing persisted. A query may set its own policy: the session query of
 * `src/app/session-gate.ts` sets its own retry, and the shell's session observer
 * (`src/app/app-shell.tsx`) is the only one that refetches on window focus.
 */
import { QueryClient } from '@tanstack/react-query';

import { toApiError } from './errors.js';

/** At most one retry, and only when the failure is a network failure or a 5xx. */
export function retryApiCall(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && toApiError(error).kind === 'server';
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: retryApiCall, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}
