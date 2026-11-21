/**
 * Ending the session on the client (design D4, D12 and Q69, Q73), shared by the shell and
 * the gate pages: clear the query cache and the session-bound stores, then land on
 * `/sign-in`. Theme and locale stay.
 */
import type { QueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useCallback, useRef } from 'react';

import type { AuthClient } from '../api/auth-client.js';
import { safeReturnPath } from '../lib/return-path.js';
import { resetSessionStores } from '../state/session-stores.js';

/**
 * Ends the session on the client: clears the cache and the session-bound stores, then
 * goes to `/sign-in`, with `returnTo` when given. It runs at most once per mount.
 */
export function useEndSession(queryClient: QueryClient) {
  const router = useRouter();
  const ending = useRef(false);

  const begin = useCallback((): boolean => {
    if (ending.current) return false;
    ending.current = true;
    return true;
  }, []);

  const finish = useCallback(
    (returnTo?: string): void => {
      queryClient.clear();
      resetSessionStores();
      void router.navigate(
        returnTo === undefined ? { to: '/sign-in' } : { to: '/sign-in', search: { returnTo } },
      );
    },
    [queryClient, router],
  );

  /** D4: the session is gone on the server; come back to the current path afterwards. */
  const onUnauthenticated = useCallback((): void => {
    if (!begin()) return;
    const { pathname, search } = router.history.location;
    finish(safeReturnPath(`${pathname}${search}`));
  }, [begin, finish, router]);

  /** The local state is cleared whatever the server answers: the cookie is not ours. */
  const signOut = useCallback(
    async (authClient: Pick<AuthClient, 'signOut'>): Promise<void> => {
      if (!begin()) return;
      await authClient.signOut();
      finish();
    },
    [begin, finish],
  );

  return { onUnauthenticated, signOut };
}
