/**
 * The search page, `/search?q=` (design D14, D12, D15 and Q65, Q67, Q84, Q85, Q89).
 *
 * The page has no input of its own: it searches the `q` in the URL once, with the API's
 * maximum `limit` of 50, sending `q` exactly as the URL holds it. An absent, empty or
 * whitespace-only `q` shows a prompt, and a `q` shorter than the API's 2 characters
 * (after trimming and NFC normalization, as the server counts) shows a hint; neither
 * sends a request.
 *
 * Each result shows its title, its identifier through `EntityLink`, and its blueprint's
 * localized title, read from the sidebar's `blueprints.list` answer (no per-result
 * `blueprints.get`), or the blueprint identifier when that list does not hold it.
 *
 * States, as the table's (Q84): a busy status while the call is pending, the empty text
 * for an answer with no items (also what another tenant's entity looks like), otherwise
 * one alert whose localized text depends on the error kind only, never on the server's
 * message. The shell handles `unauthenticated` (Q69).
 *
 * The query lives only in the URL and the in-memory query cache, never in browser
 * storage (D15).
 */
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { useApiClient } from '../api/api-client-context.js';
import { toApiError, type ApiError } from '../api/errors.js';
import { sidebarBlueprintsQuery } from '../app/blueprint-sidebar.js';
import { searchPageSearchSchema } from '../app/search-params.js';
import { EntityLink } from '../catalog/entity-link.js';
import { currentLocale } from '../i18n/i18n.js';

import {
  MIN_QUERY_LENGTH,
  blueprintTitle,
  countedLength,
  type SearchItem,
} from './search-results.js';

/** The most results the API answers in one call (`CatalogLimits`). */
const SEARCH_LIMIT = 50;

const COLUMN_KEYS = [
  'page.columns.title',
  'page.columns.identifier',
  'page.columns.blueprint',
] as const;

type ErrorMessageKey = 'page.error.forbidden' | 'page.error.server' | 'page.error.rateLimited';

/** The localized text of a failure, by kind only; every other kind is the generic one. */
function errorMessageKey(error: ApiError): ErrorMessageKey {
  switch (error.kind) {
    case 'forbidden':
      return 'page.error.forbidden';
    case 'rate_limited':
      return 'page.error.rateLimited';
    default:
      return 'page.error.server';
  }
}

/** What the page does with the URL's `q`: nothing to send, too short, or a search. */
type QueryState =
  { readonly kind: 'prompt' | 'tooShort' } | { readonly kind: 'search'; readonly q: string };

function queryState(q: string | undefined): QueryState {
  const counted = countedLength(q ?? '');
  if (q === undefined || counted === 0) return { kind: 'prompt' };
  if (counted < MIN_QUERY_LENGTH) return { kind: 'tooShort' };
  return { kind: 'search', q };
}

/** A row spanning every column, for the loading status or the empty text. */
function FullWidthRow({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <TableRow>
      <TableCell colSpan={COLUMN_KEYS.length} className="text-center text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

/** A stable row key: one entity per blueprint and identifier. */
function rowKey(item: SearchItem): string {
  return JSON.stringify([item.blueprint, item.identifier]);
}

function SearchResults({ q }: { readonly q: string }): React.JSX.Element | null {
  const { t, i18n } = useTranslation('search');
  const locale = currentLocale(i18n);
  const apiClient = useApiClient();
  const results = useQuery({
    queryKey: ['search', 'entities', { q, limit: SEARCH_LIMIT }],
    queryFn: () => apiClient.search.entities({ q, limit: SEARCH_LIMIT }),
  });
  // The sidebar's own query, observed only: the shell's sidebar sends it, and the page
  // reads its cached answer without ever sending a request of its own.
  const blueprints = useQuery({ ...sidebarBlueprintsQuery(apiClient), enabled: false });

  const error = results.error === null ? undefined : toApiError(results.error);
  // The shell clears the session and lands on sign-in (Q69).
  if (error?.kind === 'unauthenticated') return null;
  if (error !== undefined) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t(errorMessageKey(error))}</AlertDescription>
      </Alert>
    );
  }

  const items = results.data?.items;
  return (
    <Table>
      <TableCaption className="sr-only">{t('page.title')}</TableCaption>
      <TableHeader>
        <TableRow>
          {COLUMN_KEYS.map((key) => (
            <TableHead key={key}>{t(key)}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items === undefined && (
          <FullWidthRow>
            <p role="status" aria-busy="true">
              {t('page.loading')}
            </p>
          </FullWidthRow>
        )}
        {items?.length === 0 && <FullWidthRow>{t('page.empty')}</FullWidthRow>}
        {items?.map((item) => (
          <TableRow key={rowKey(item)}>
            <TableCell>{item.title}</TableCell>
            <TableCell>
              <EntityLink blueprint={item.blueprint} identifier={item.identifier} />
            </TableCell>
            <TableCell>{blueprintTitle(blueprints.data?.items, item.blueprint, locale)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SearchContent(): React.JSX.Element {
  // `catalog` too: `EntityLink` reads it, so it never suspends the results on its own.
  const { t } = useTranslation(['search', 'catalog']);
  // `unknown`: the hook is typed `any` inside the tree that the router type comes from.
  const rawSearch: unknown = useSearch({ strict: false });
  const state = queryState(searchPageSearchSchema.parse(rawSearch).q);

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">{t('page.title')}</h1>
      {state.kind === 'prompt' && <p className="text-muted-foreground">{t('page.prompt')}</p>}
      {state.kind === 'tooShort' && <p className="text-muted-foreground">{t('page.tooShort')}</p>}
      {state.kind === 'search' && <SearchResults q={state.q} />}
    </div>
  );
}

/** The `search` page. Its namespaces load on demand, inside its own boundary. */
export function SearchPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <SearchContent />
    </Suspense>
  );
}
