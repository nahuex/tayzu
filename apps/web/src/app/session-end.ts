/**
 * The end of a session as the shell sees it (design D4 and Q68, Q69): any query or
 * mutation of the cache that fails with the `unauthenticated` kind (the uniform `401`
 * of D8) means the session is gone.
 */
import type { QueryClient } from '@tanstack/react-query';

import { toApiError } from '../api/errors.js';

import { SessionReadError } from './session-gate.js';

/** True for an `unauthenticated` failure, from a catalog call or from the session read. */
export function isUnauthenticated(error: unknown): boolean {
  if (error instanceof SessionReadError) return error.kind === 'unauthenticated';
  return toApiError(error).kind === 'unauthenticated';
}

/**
 * Calls `onUnauthenticated` whenever a query or a mutation of `queryClient` fails with
 * the `unauthenticated` kind. Returns the function that stops listening.
 */
export function subscribeToUnauthenticated(
  queryClient: QueryClient,
  onUnauthenticated: () => void,
): () => void {
  const stopQueries = queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type === 'updated' &&
      event.action.type === 'error' &&
      isUnauthenticated(event.action.error)
    ) {
      onUnauthenticated();
    }
  });
  const stopMutations = queryClient.getMutationCache().subscribe((event) => {
    if (
      event.type === 'updated' &&
      event.action.type === 'error' &&
      isUnauthenticated(event.action.error)
    ) {
      onUnauthenticated();
    }
  });
  return () => {
    stopQueries();
    stopMutations();
  };
}
