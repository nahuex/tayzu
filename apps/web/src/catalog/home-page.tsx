/**
 * The home page, `/` (design D12 and Q84, Q89, Q97): the tenant's blueprints, each a
 * link to its table.
 *
 * It lists the sidebar's `blueprints.list` answer in the sidebar's order (`systemLast`),
 * observing the sidebar's query without ever sending a request of its own (Q89). It is
 * a plain list, not a second `navigation` landmark. Titles are localized, with `en` as
 * the fallback, and rendered as React text.
 *
 * States, as the table's (Q84): a busy status while the list is pending, the empty text
 * for an answer with no items, otherwise one alert whose localized text depends on the
 * error kind only, never on the server's message. The shell handles `unauthenticated`
 * (Q69).
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';

import { useApiClient } from '../api/api-client-context.js';
import { toApiError, type ApiError } from '../api/errors.js';
import { sidebarBlueprintsQuery, systemLast } from '../app/blueprint-sidebar.js';
import { currentLocale, localizedText } from '../i18n/i18n.js';

type ErrorMessageKey = 'home.error.forbidden' | 'home.error.server' | 'home.error.rateLimited';

/** The localized text of a failure, by kind only; every other kind is the generic one. */
function errorMessageKey(error: ApiError): ErrorMessageKey {
  switch (error.kind) {
    case 'forbidden':
      return 'home.error.forbidden';
    case 'rate_limited':
      return 'home.error.rateLimited';
    default:
      return 'home.error.server';
  }
}

function BlueprintList(): React.JSX.Element | null {
  const { t, i18n } = useTranslation('catalog');
  const locale = currentLocale(i18n);
  const apiClient = useApiClient();
  // The sidebar's own query, observed only: the shell's sidebar sends it.
  const blueprints = useQuery({ ...sidebarBlueprintsQuery(apiClient), enabled: false });

  const error = blueprints.error === null ? undefined : toApiError(blueprints.error);
  // The shell clears the session and lands on sign-in (Q69).
  if (error?.kind === 'unauthenticated') return null;
  if (error !== undefined) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t(errorMessageKey(error))}</AlertDescription>
      </Alert>
    );
  }

  const items = blueprints.data?.items;
  if (items === undefined) {
    return (
      <p role="status" aria-busy="true" className="text-muted-foreground">
        {t('home.loading')}
      </p>
    );
  }
  if (items.length === 0) return <p className="text-muted-foreground">{t('home.empty')}</p>;

  return (
    <ul className="flex flex-col gap-1">
      {systemLast(items).map((blueprint) => (
        <li key={blueprint.identifier}>
          <Link
            to="/catalog/$blueprint"
            params={{ blueprint: blueprint.identifier }}
            className="block rounded-md px-2 py-1 hover:bg-muted"
          >
            {localizedText(blueprint.title, locale)}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function HomeContent(): React.JSX.Element {
  const { t } = useTranslation('catalog');
  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">{t('home.title')}</h1>
      <BlueprintList />
    </div>
  );
}

/** The `home` page. Its namespace loads on demand, inside its own boundary. */
export function HomePage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <HomeContent />
    </Suspense>
  );
}
