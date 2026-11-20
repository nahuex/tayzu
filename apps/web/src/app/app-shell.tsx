/**
 * The app shell (design D12, Shell, D4 and Q68, Q69): a skip link, the header (product
 * name, search trigger, locale selector, theme toggle, user menu), the blueprint sidebar
 * and the `main` landmark holding the page. Only the signed-in routes render it.
 *
 * The shell's session observer is the app's only query that refetches on window focus
 * (D4). When that refetch reports a gate, the session guards run again and move to the
 * gate's page; when it answers `401`, the session ends as below.
 *
 * The session ends here in two ways, both clearing the query cache and the
 * session-bound stores and landing on `/sign-in`: sign-out, and any `unauthenticated`
 * answer of a query or mutation while the shell is mounted, which keeps the current
 * path as `returnTo`. Theme and locale stay.
 */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

import type { AuthClient } from '../api/auth-client.js';
import type { ApiClient } from '../api/client.js';
import { safeReturnPath } from '../lib/return-path.js';
import { resetSessionStores } from '../state/session-stores.js';
import type { ThemeStore } from '../state/theme.js';

import { BlueprintSidebar } from './blueprint-sidebar.js';
import { LocaleSelector } from './locale-selector.js';
import { sessionQueryOptions, type SessionSource } from './session-gate.js';
import { subscribeToUnauthenticated } from './session-end.js';
import { ThemeToggle } from './theme-toggle.js';
import { UserMenu } from './user-menu.js';

/** What the shell needs besides the session source; `main.tsx` passes all of it. */
export interface ShellSources {
  readonly apiClient: Pick<ApiClient, 'blueprints'>;
  readonly authClient: Pick<AuthClient, 'signOut'>;
  readonly themeStore: ThemeStore;
}

const MAIN_ID = 'main-content';

/**
 * Ends the session on the client: clears the cache and the session-bound stores, then
 * goes to `/sign-in`, with `returnTo` when given. It runs at most once per mount.
 */
function useEndSession(queryClient: QueryClient) {
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

export function AppShell({
  apiClient,
  authClient,
  themeStore,
  session,
  children,
}: ShellSources & { session: SessionSource; children: ReactNode }): React.JSX.Element {
  const { t } = useTranslation('common');
  const { queryClient } = session;
  const { onUnauthenticated, signOut } = useEndSession(queryClient);
  const mainRef = useRef<HTMLElement>(null);
  const router = useRouter();
  // The gate has just read the session, so mounting does not read it again. D4: this is
  // the only query that refetches on window focus ('always', whatever its staleness);
  // `staleTime: 'static'` would block that refetch, so the data is only never stale.
  const me = useQuery(
    {
      ...sessionQueryOptions(session.authClient),
      staleTime: Infinity,
      refetchOnWindowFocus: 'always',
    },
    queryClient,
  );
  const gate = me.data?.gate;

  // D12: a refetch that reports a gate reruns the session guards, which read the fresh
  // cached session and redirect to the gate's page before any catalog route is called.
  useEffect(() => {
    if (gate !== undefined && gate !== 'none') void router.invalidate();
  }, [gate, router]);

  useEffect(
    () => subscribeToUnauthenticated(queryClient, onUnauthenticated),
    [queryClient, onUnauthenticated],
  );

  /** The skip link moves focus to `main` itself, so the URL and the router stay put. */
  const onSkip = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    mainRef.current?.focus();
  };

  return (
    <div className="flex min-h-svh flex-col">
      <a
        href={`#${MAIN_ID}`}
        onClick={onSkip}
        className="sr-only rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:ring-3 focus:ring-ring/50"
      >
        {t('skipToContent')}
      </a>
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <span className="text-lg font-semibold">{t('appName')}</span>
        <div className="ml-auto flex items-center gap-1">
          {/* Task 9.1 makes the trigger open the search dialog. */}
          <Button variant="outline" type="button">
            <SearchIcon aria-hidden="true" />
            <span>{t('search.open')}</span>
            <kbd aria-hidden="true" className="ml-2 font-sans text-xs text-muted-foreground">
              Ctrl K
            </kbd>
          </Button>
          <LocaleSelector />
          <ThemeToggle store={themeStore} />
          <UserMenu
            me={me.data}
            onSignOut={() => {
              void signOut(authClient);
            }}
          />
        </div>
      </header>
      <div className="flex flex-1">
        <aside className="w-60 shrink-0 border-r">
          <BlueprintSidebar apiClient={apiClient} queryClient={queryClient} />
        </aside>
        <main id={MAIN_ID} ref={mainRef} tabIndex={-1} className="flex-1 outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
