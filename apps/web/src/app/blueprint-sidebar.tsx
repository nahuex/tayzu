/**
 * The shell's sidebar (design D12, Shell, and Q69): the tenant's blueprints from one
 * `blueprints.list` call at the maximum page size (`CatalogLimits.maxPageSize`, 500). It
 * never follows the returned cursor. The `_`-prefixed system blueprints come after the
 * others, each group in the API's order. Titles are localized, with `en` as the fallback.
 */
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../api/client.js';
import { currentLocale, localizedText } from '../i18n/i18n.js';

/** The page size of the single sidebar call: the catalog's maximum. */
const SIDEBAR_PAGE_SIZE = 500;

export const SIDEBAR_QUERY_KEY = ['blueprints', 'list', { pageSize: SIDEBAR_PAGE_SIZE }] as const;

/**
 * The sidebar's one `blueprints.list` call. Other views that need the blueprint titles
 * (search, Q89) use these same options, so they share the sidebar's cached answer and
 * never send a request of their own.
 */
export function sidebarBlueprintsQuery(apiClient: Pick<ApiClient, 'blueprints'>) {
  return queryOptions({
    queryKey: SIDEBAR_QUERY_KEY,
    queryFn: () => apiClient.blueprints.list({ pageSize: SIDEBAR_PAGE_SIZE }),
  });
}

/** The reserved prefix of the system blueprints (`_team`, `_user`). */
const SYSTEM_PREFIX = '_';

/** Tenant blueprints first, then the system ones; each group keeps its order. */
function systemLast<T extends { identifier: string }>(blueprints: readonly T[]): T[] {
  const isSystem = (blueprint: T) => blueprint.identifier.startsWith(SYSTEM_PREFIX);
  return [
    ...blueprints.filter((blueprint) => !isSystem(blueprint)),
    ...blueprints.filter(isSystem),
  ];
}

export function BlueprintSidebar({
  apiClient,
  queryClient,
}: {
  apiClient: Pick<ApiClient, 'blueprints'>;
  queryClient: QueryClient;
}): React.JSX.Element {
  const { t, i18n } = useTranslation('common');
  const locale = currentLocale(i18n);
  const blueprints = useQuery(sidebarBlueprintsQuery(apiClient), queryClient);

  return (
    <nav aria-label={t('nav.catalog')} className="flex flex-col gap-1 p-3">
      <ul className="flex flex-col gap-1">
        {systemLast(blueprints.data?.items ?? []).map((blueprint) => (
          <li key={blueprint.identifier}>
            <Link
              to="/catalog/$blueprint"
              params={{ blueprint: blueprint.identifier }}
              className="block rounded-md px-2 py-1 text-sm hover:bg-muted data-[status=active]:bg-muted data-[status=active]:font-medium"
            >
              {localizedText(blueprint.title, locale)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
