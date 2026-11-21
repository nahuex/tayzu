/**
 * The catalog table page, `/catalog/$blueprint` (design D13, D12, D16 and Q36, Q68, Q83).
 *
 * The blueprint is read once (`blueprints.get`) and its entities page by page
 * (`entities.list`), always with an explicit `sort`, `order` and `pageSize`, and with a
 * `cursor` only past the first page. Those four values live in the URL, whose route
 * strips the defaults (Q68).
 *
 * Paging keeps the cursors already visited in memory, in order: "Next" keeps the
 * current page's place and follows the cursor the API returned, "Previous" goes back to
 * the cursor before the current one (none for the first page). A sort, order, page-size
 * or blueprint change starts over on the first page with nothing kept. A cursor in the
 * URL that this page did not reach itself (a reload, or a pasted URL) is never sent: the
 * page restarts from the first page of the same sort and drops it from the URL (D13).
 *
 * Only identifier, title and updated, the API's sort keys (D6), are sortable. A newly
 * chosen column sorts ascending; the sorted one toggles its order.
 *
 * States (D13, Q84): a busy status while either call is pending; the empty text for a
 * page with no items, which is also how a denied list answers; the not-found page for a
 * `not_found` answer of either call; otherwise one alert whose localized text depends on
 * the error kind only, never on the server's message. A cursor the server refuses
 * (`validation` on `/cursor`, D6) restarts from the first page, with no message.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useRouter, useSearch } from '@tanstack/react-router';
import { ArrowDownIcon, ArrowUpIcon, ArrowUpDownIcon } from 'lucide-react';
import { Suspense, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TooltipProvider } from '@/components/ui/tooltip';

import { useApiClient } from '../api/api-client-context.js';
import type { ApiClient } from '../api/client.js';
import { toApiError, type ApiError } from '../api/errors.js';
import { NotFoundPage } from '../app/not-found-page.js';
import { PAGE_SIZES, tableSearchSchema, type TableSearch } from '../app/search-params.js';
import { currentLocale, localizedText, type Locale } from '../i18n/i18n.js';
import { formatDate } from '../lib/format.js';

import { PropertyCell } from './cells.js';
import {
  columnsFor,
  isAddressableIdentifier,
  type CatalogColumn,
  type PropertyDefinition,
} from './columns.js';
import { isCursorRefusal } from './paging.js';

type Entity = Awaited<ReturnType<ApiClient['entities']['list']>>['items'][number];
type SortField = TableSearch['sort'];
type SortOrder = TableSearch['order'];

/** The search state with its cursor; `undefined` is the first page. */
type TableLocation = Omit<TableSearch, 'cursor'> & { cursor: string | undefined };

/** The cursors visited from the first page of one sort, in order (none for page 1). */
interface CursorTrail {
  readonly key: string;
  readonly cursors: readonly string[];
}

/** The fixed columns that are the API's sort keys (D6). */
const SORTABLE: Readonly<Partial<Record<CatalogColumn['kind'], SortField>>> = {
  identifier: 'identifier',
  title: 'title',
  updatedAt: 'updatedAt',
};

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const;

type ErrorMessageKey = 'table.error.forbidden' | 'table.error.server' | 'table.error.rateLimited';

/** The localized text of a failure, by kind only; every other kind is the generic one. */
function errorMessageKey(error: ApiError): ErrorMessageKey {
  switch (error.kind) {
    case 'forbidden':
      return 'table.error.forbidden';
    case 'rate_limited':
      return 'table.error.rateLimited';
    default:
      return 'table.error.server';
  }
}

/** A row spanning every column, for the loading status or the empty text. */
function FullWidthRow(props: {
  readonly columns: number;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <TableRow>
      <TableCell colSpan={props.columns} className="text-center text-muted-foreground">
        {props.children}
      </TableCell>
    </TableRow>
  );
}

function LoadingStatus(): React.JSX.Element {
  const { t } = useTranslation('catalog');
  return (
    <p role="status" aria-busy="true">
      {t('table.loading')}
    </p>
  );
}

/** The blueprint and paging inputs that, when they change, start over on page 1. */
function pagingKey(blueprint: string, search: TableSearch): string {
  return JSON.stringify([blueprint, search.sort, search.order, search.pageSize]);
}

/** A relation value (target identifiers) rendered as a string, or an array of them. */
function relationSchema(column: Extract<CatalogColumn, { kind: 'relation' }>): PropertyDefinition {
  const { title, many } = column.definition;
  return many ? { type: 'array', title, items: { type: 'string' } } : { type: 'string', title };
}

function SortIcon({ order }: { readonly order: SortOrder | undefined }): React.JSX.Element {
  if (order === undefined) return <ArrowUpDownIcon aria-hidden="true" />;
  return order === 'asc' ? (
    <ArrowUpIcon aria-hidden="true" />
  ) : (
    <ArrowDownIcon aria-hidden="true" />
  );
}

function ColumnHeader(props: {
  readonly column: CatalogColumn;
  readonly search: TableSearch;
  readonly onSort: (field: SortField) => void;
}): React.JSX.Element {
  const { column, search, onSort } = props;
  const field = SORTABLE[column.kind];
  if (field === undefined) return <TableHead>{column.header}</TableHead>;
  const sorted = search.sort === field;
  return (
    <TableHead aria-sort={sorted ? ARIA_SORT[search.order] : undefined}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          onSort(field);
        }}
      >
        {column.header}
        <SortIcon order={sorted ? search.order : undefined} />
      </Button>
    </TableHead>
  );
}

function IdentifierCell(props: {
  readonly blueprint: string;
  readonly identifier: string;
}): React.JSX.Element {
  const { t } = useTranslation('catalog');
  const { blueprint, identifier } = props;
  if (!isAddressableIdentifier(identifier)) {
    return (
      <span className="flex flex-col">
        <span>{identifier}</span>
        <span className="text-xs text-muted-foreground">{t('table.notAddressable')}</span>
      </span>
    );
  }
  return (
    <Link
      to="/catalog/$blueprint/$entity"
      params={{ blueprint, entity: identifier }}
      className="underline-offset-4 hover:underline"
    >
      {identifier}
    </Link>
  );
}

function EntityCell(props: {
  readonly column: CatalogColumn;
  readonly entity: Entity;
  readonly locale: Locale;
}): React.JSX.Element {
  const { column, entity, locale } = props;
  switch (column.kind) {
    case 'identifier':
      return <IdentifierCell blueprint={entity.blueprint} identifier={entity.identifier} />;
    case 'title':
      return <>{entity.title}</>;
    case 'property':
      return (
        <PropertyCell
          value={entity.spec.properties[column.key]}
          schema={column.definition}
          locale={locale}
        />
      );
    case 'relation':
      return (
        <PropertyCell
          value={entity.spec.relations[column.key]}
          schema={relationSchema(column)}
          locale={locale}
        />
      );
    case 'updatedAt':
      return <>{formatDate(entity.updatedAt, locale)}</>;
  }
}

function CatalogTableContent(): React.JSX.Element | null {
  const { t, i18n } = useTranslation('catalog');
  const locale = currentLocale(i18n);
  const apiClient = useApiClient();
  const router = useRouter();
  // `unknown`: the hooks are typed `any` inside the tree that the router type comes from.
  const params: unknown = useParams({ strict: false });
  const rawSearch: unknown = useSearch({ strict: false });
  const blueprint = (params as { blueprint: string }).blueprint;
  const search = tableSearchSchema.parse(rawSearch);
  const { sort, order, pageSize } = search;

  const key = pagingKey(blueprint, search);
  const [trail, setTrail] = useState<CursorTrail>({ key, cursors: [] });
  // Another sort or blueprint starts with nothing visited.
  const visited = trail.key === key ? trail.cursors : [];
  const cursor =
    search.cursor !== undefined && visited.includes(search.cursor) ? search.cursor : undefined;
  const staleCursor = search.cursor !== undefined && cursor === undefined;
  const position = cursor === undefined ? -1 : visited.indexOf(cursor);

  const go = (next: TableLocation, replace = false): void => {
    void router.navigate({
      to: '/catalog/$blueprint',
      params: { blueprint },
      search: next,
      replace,
    });
  };

  // D13: a cursor this page did not reach is never sent; the URL drops it.
  useEffect(() => {
    if (!staleCursor) return;
    void router.navigate({
      to: '/catalog/$blueprint',
      params: { blueprint },
      search: { sort, order, pageSize, cursor: undefined },
      replace: true,
    });
  }, [staleCursor, router, blueprint, sort, order, pageSize]);

  const blueprintQuery = useQuery({
    queryKey: ['blueprints', 'get', { blueprint }],
    queryFn: () => apiClient.blueprints.get({ blueprint }),
  });
  const page = useQuery({
    queryKey: ['entities', 'list', { blueprint, sort, order, pageSize, cursor }],
    queryFn: () =>
      apiClient.entities.list({
        blueprint,
        sort,
        order,
        pageSize,
        ...(cursor === undefined ? {} : { cursor }),
      }),
  });

  const blueprintError =
    blueprintQuery.error === null ? undefined : toApiError(blueprintQuery.error);
  const pageError = page.error === null ? undefined : toApiError(page.error);

  // D6: a refused cursor forgets the visited ones, so this page renders again at once on
  // the first page (state set while rendering, as React allows), and the effect above
  // drops the cursor from the URL.
  if (cursor !== undefined && isCursorRefusal(pageError)) {
    setTrail({ key, cursors: [] });
    return null;
  }

  const errors = [blueprintError, pageError].filter(
    (error): error is ApiError => error !== undefined,
  );
  if (errors.some((error) => error.kind === 'not_found')) return <NotFoundPage />;
  // The shell clears the session and lands on sign-in (Q69).
  if (errors.some((error) => error.kind === 'unauthenticated')) return null;
  const failure = errors[0];
  if (failure !== undefined) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Alert variant="destructive">
          <AlertDescription>{t(errorMessageKey(failure))}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const definition = blueprintQuery.data;
  if (definition === undefined) {
    return (
      <div className="p-4">
        <LoadingStatus />
      </div>
    );
  }

  const title = localizedText(definition.title, locale);
  const columns = columnsFor(definition, locale, (text) => t(text));
  const items = page.data?.items;
  const nextCursor = page.data?.cursor;

  const onSort = (field: SortField): void => {
    const nextOrder: SortOrder = field === sort && order === 'asc' ? 'desc' : 'asc';
    go({ sort: field, order: nextOrder, pageSize, cursor: undefined });
  };

  const onNext = (): void => {
    if (nextCursor === undefined) return;
    // Recorded before navigating, so the new URL's cursor is known when it renders.
    setTrail({ key, cursors: [...visited.slice(0, position + 1), nextCursor] });
    go({ sort, order, pageSize, cursor: nextCursor });
  };

  const onPrevious = (): void => {
    if (cursor === undefined) return;
    go({ sort, order, pageSize, cursor: position > 0 ? visited[position - 1] : undefined });
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      <Table>
        <TableCaption className="sr-only">{title}</TableCaption>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <ColumnHeader key={column.id} column={column} search={search} onSort={onSort} />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items === undefined && (
            <FullWidthRow columns={columns.length}>
              <LoadingStatus />
            </FullWidthRow>
          )}
          {items?.length === 0 && (
            <FullWidthRow columns={columns.length}>{t('table.empty')}</FullWidthRow>
          )}
          {items?.map((entity) => (
            <TableRow key={entity.identifier}>
              {columns.map((column) => (
                <TableCell key={column.id}>
                  <EntityCell column={column} entity={entity} locale={locale} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex items-center gap-2">
        <PageSizeSelect
          value={pageSize}
          onChange={(size) => {
            go({ sort, order, pageSize: size, cursor: undefined });
          }}
        />
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={cursor === undefined}
            onClick={onPrevious}
          >
            {t('table.pagination.previous')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={nextCursor === undefined}
            onClick={onNext}
          >
            {t('table.pagination.next')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PageSizeSelect(props: {
  readonly value: TableSearch['pageSize'];
  readonly onChange: (size: TableSearch['pageSize']) => void;
}): React.JSX.Element {
  const { t } = useTranslation('catalog');
  const id = useId();
  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={id}>{t('table.pageSize.label')}</label>
      <select
        id={id}
        value={String(props.value)}
        onChange={(event) => {
          const size = PAGE_SIZES.find((candidate) => String(candidate) === event.target.value);
          if (size !== undefined) props.onChange(size);
        }}
        className="h-8 rounded-lg border border-input bg-background px-2"
      >
        {PAGE_SIZES.map((size) => (
          <option key={size} value={String(size)}>
            {size}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The `catalogTable` page. The `catalog` namespace loads on demand, inside its own boundary. */
export function CatalogTablePage(): React.JSX.Element {
  return (
    <TooltipProvider>
      <Suspense fallback={null}>
        <CatalogTableContent />
      </Suspense>
    </TooltipProvider>
  );
}
