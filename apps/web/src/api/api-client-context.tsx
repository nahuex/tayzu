/**
 * The API client's React context (design D4 and Q83). The app shell provides the one
 * catalog client it gets from `main.tsx`; the catalog pages read it with `useApiClient()`.
 */
import { createContext, useContext, type ReactNode } from 'react';

import type { ApiClient } from './client.js';

const ApiClientContext = createContext<ApiClient | undefined>(undefined);

export function ApiClientProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: ReactNode;
}): React.JSX.Element {
  return <ApiClientContext value={client}>{children}</ApiClientContext>;
}

/** The provided API client. It throws outside an `ApiClientProvider`: fail closed. */
export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client === undefined) throw new Error('useApiClient needs an ApiClientProvider');
  return client;
}
