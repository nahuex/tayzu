/**
 * The auth client's React context (design D11 and Q71). `main.tsx` provides the one
 * client of the app; the authentication pages read it with `useAuthClient()`.
 */
import { createContext, useContext, type ReactNode } from 'react';

import type { AuthClient } from './auth-client.js';

const AuthClientContext = createContext<AuthClient | undefined>(undefined);

export function AuthClientProvider({
  client,
  children,
}: {
  client: AuthClient;
  children: ReactNode;
}): React.JSX.Element {
  return <AuthClientContext value={client}>{children}</AuthClientContext>;
}

/** The provided auth client. It throws outside an `AuthClientProvider`: fail closed. */
export function useAuthClient(): AuthClient {
  const client = useContext(AuthClientContext);
  if (client === undefined) throw new Error('useAuthClient needs an AuthClientProvider');
  return client;
}
