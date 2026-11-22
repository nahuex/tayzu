/**
 * The entity page's Related tab (design D13, D12, D16 and Q36, Q83, Q84, Q87).
 *
 * `entities.listRelated` is read only while this panel is rendered, that is while the
 * Related tab is selected. Direction (native radios, Forward by default) and scope (a
 * native select, both scopes by default) are component state, never URL state: D12 gives
 * the entity route only `tab`. Every call sends `direction`, `scope` and `pageSize`
 * explicitly, and `cursor` only past the first page.
 *
 * Paging, as the table's (Q83): "Next" pushes the cursor the API returned on an in-memory
 * stack and "Previous" pops it. A direction or scope change starts over on the first page
 * with an empty stack. A cursor the server refuses (`validation` on `/cursor`, D6)
 * restarts from the first page with no message, and is never sent again.
 *
 * Each row shows the relation, the item's entity through `EntityLink`, its title, its
 * blueprint identifier (no per-row `blueprints.get`) and the localized scope, since
 * "both" may list one relation twice.
 *
 * States, as the table's (Q84), all inside the panel: a busy status while the call is
 * pending, the empty text for a page with no items, otherwise one alert whose localized
 * text depends on the error kind only, never on the server's message.
 */
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
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

import { useApiClient } from '../api/api-client-context.js';
import type { ApiClient } from '../api/client.js';
import { toApiError, type ApiError } from '../api/errors.js';

import { EntityLink } from './entity-link.js';
import { isCursorRefusal } from './paging.js';

type RelatedItem = Awaited<ReturnType<ApiClient['entities']['listRelated']>>['items'][number];
/**
 * The API's `direction` input. Spelled out: the contract's input schema preprocesses the
 * path parameter, so the client's input type is `unknown`.
 */
type Direction = 'forward' | 'backward';
/** The row scopes, or both of them, as the API's `scope` filter. */
type ScopeFilter = RelatedItem['scope'] | 'both';

/** One page of the related list, fixed as the table's default (Q87). */
const PAGE_SIZE = 50;

const DIRECTIONS = ['forward', 'backward'] as const satisfies readonly Direction[];
const SCOPE_FILTERS = ['both', 'spec', 'status'] as const satisfies readonly ScopeFilter[];

const DIRECTION_KEYS = {
  forward: 'entity.related.direction.forward',
  backward: 'entity.related.direction.backward',
} as const satisfies Record<Direction, string>;

const SCOPE_KEYS = {
  both: 'entity.related.scope.both',
  spec: 'entity.related.scope.spec',
  status: 'entity.related.scope.status',
} as const satisfies Record<ScopeFilter, string>;

const COLUMN_KEYS = [
  'entity.related.columns.relation',
  'entity.related.columns.identifier',
  'entity.related.columns.title',
  'entity.related.columns.blueprint',
  'entity.related.columns.scope',
] as const;

type ErrorMessageKey =
  | 'entity.related.error.forbidden'
  | 'entity.related.error.server'
  | 'entity.related.error.rateLimited';

/** The localized text of a failure, by kind only; every other kind is the generic one. */
function errorMessageKey(error: ApiError): ErrorMessageKey {
  switch (error.kind) {
    case 'forbidden':
      return 'entity.related.error.forbidden';
    case 'rate_limited':
      return 'entity.related.error.rateLimited';
    default:
      return 'entity.related.error.server';
  }
}

/** The cursor stack of the current direction and scope, and every cursor refused. */
interface Paging {
  /** The cursors followed from the first page, in order; the last is the current page's. */
  readonly cursors: readonly string[];
  /** Cursors the server refused (D6); none is ever sent again. */
  readonly refused: readonly string[];
}

function isDirection(value: string): value is Direction {
  return (DIRECTIONS as readonly string[]).includes(value);
}

function isScopeFilter(value: string): value is ScopeFilter {
  return (SCOPE_FILTERS as readonly string[]).includes(value);
}

/** A stable row key: "both" may list one relation once per scope. */
function rowKey(item: RelatedItem): string {
  return JSON.stringify([item.relation, item.scope, item.entity.blueprint, item.entity.identifier]);
}

function DirectionToggle(props: {
  readonly value: Direction;
  readonly onChange: (direction: Direction) => void;
}): React.JSX.Element {
  const { t } = useTranslation('catalog');
  const name = useId();
  return (
    <fieldset className="flex items-center gap-3 text-sm">
      <legend className="sr-only">{t('entity.related.direction.label')}</legend>
      {DIRECTIONS.map((direction) => (
        <label key={direction} className="flex items-center gap-1.5">
          <input
            type="radio"
            name={name}
            value={direction}
            checked={props.value === direction}
            onChange={(event) => {
              if (isDirection(event.target.value)) props.onChange(event.target.value);
            }}
          />
          {t(DIRECTION_KEYS[direction])}
        </label>
      ))}
    </fieldset>
  );
}

function ScopeSelect(props: {
  readonly value: ScopeFilter;
  readonly onChange: (scope: ScopeFilter) => void;
}): React.JSX.Element {
  const { t } = useTranslation('catalog');
  const id = useId();
  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={id}>{t('entity.related.scope.label')}</label>
      <select
        id={id}
        value={props.value}
        onChange={(event) => {
          if (isScopeFilter(event.target.value)) props.onChange(event.target.value);
        }}
        className="h-8 rounded-lg border border-input bg-background px-2"
      >
        {SCOPE_FILTERS.map((scope) => (
          <option key={scope} value={scope}>
            {t(SCOPE_KEYS[scope])}
          </option>
        ))}
      </select>
    </div>
  );
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

/** The Related panel of the entity `entity` of `blueprint`. */
export function EntityRelated(props: {
  readonly blueprint: string;
  readonly entity: string;
}): React.JSX.Element | null {
  const { blueprint, entity } = props;
  const { t } = useTranslation('catalog');
  const apiClient = useApiClient();
  const [direction, setDirection] = useState<Direction>('forward');
  const [scope, setScope] = useState<ScopeFilter>('both');
  const [paging, setPaging] = useState<Paging>({ cursors: [], refused: [] });
  const cursor = paging.cursors.at(-1);

  const page = useQuery({
    queryKey: ['entities', 'listRelated', { blueprint, entity, direction, scope, cursor }],
    queryFn: () =>
      apiClient.entities.listRelated({
        blueprint,
        entity,
        direction,
        scope,
        pageSize: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      }),
  });
  const error = page.error === null ? undefined : toApiError(page.error);

  // D6: a refused cursor empties the stack, so this panel renders again at once on the
  // first page (state set while rendering, as React allows), and is never sent again.
  if (cursor !== undefined && isCursorRefusal(error)) {
    setPaging({ cursors: [], refused: [...paging.refused, cursor] });
    return null;
  }

  /** A direction or scope change starts over on the first page. */
  const restart = (): void => {
    setPaging({ cursors: [], refused: paging.refused });
  };

  const controls = (
    <div className="flex flex-wrap items-center gap-4">
      <DirectionToggle
        value={direction}
        onChange={(next) => {
          setDirection(next);
          restart();
        }}
      />
      <ScopeSelect
        value={scope}
        onChange={(next) => {
          setScope(next);
          restart();
        }}
      />
    </div>
  );

  // The shell clears the session and lands on sign-in (Q69).
  if (error?.kind === 'unauthenticated') return null;
  if (error !== undefined) {
    return (
      <div className="flex flex-col gap-4 pt-2">
        {controls}
        <Alert variant="destructive">
          <AlertDescription>{t(errorMessageKey(error))}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const items = page.data?.items;
  const nextCursor = page.data?.cursor;
  const canGoNext = nextCursor !== undefined && !paging.refused.includes(nextCursor);

  const onNext = (): void => {
    if (!canGoNext) return;
    setPaging({ cursors: [...paging.cursors, nextCursor], refused: paging.refused });
  };

  const onPrevious = (): void => {
    setPaging({ cursors: paging.cursors.slice(0, -1), refused: paging.refused });
  };

  return (
    <div className="flex flex-col gap-4 pt-2">
      {controls}
      <Table>
        <TableCaption className="sr-only">{t('entity.related.caption')}</TableCaption>
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
                {t('entity.related.loading')}
              </p>
            </FullWidthRow>
          )}
          {items?.length === 0 && <FullWidthRow>{t('entity.related.empty')}</FullWidthRow>}
          {items?.map((item) => (
            <TableRow key={rowKey(item)}>
              <TableCell className="font-mono text-xs">{item.relation}</TableCell>
              <TableCell>
                <EntityLink blueprint={item.entity.blueprint} identifier={item.entity.identifier} />
              </TableCell>
              <TableCell>{item.entity.title}</TableCell>
              <TableCell className="font-mono text-xs">{item.entity.blueprint}</TableCell>
              <TableCell>{t(SCOPE_KEYS[item.scope])}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={cursor === undefined}
          onClick={onPrevious}
        >
          {t('entity.related.pagination.previous')}
        </Button>
        <Button type="button" variant="outline" disabled={!canGoNext} onClick={onNext}>
          {t('entity.related.pagination.next')}
        </Button>
      </div>
    </div>
  );
}
