/**
 * Search params (design D12, D13, D15 and Q67).
 *
 * The router parses the query string with `parseSearch` below, never with TanStack
 * Router's default parser, which `JSON.parse`s values and turns digits into numbers
 * before any route validates them. Here every value stays the raw decoded text, so a
 * length check comes before any further work and `q=2024` stays `'2024'`.
 *
 * Each route's schema validates its fields one by one: an invalid field falls back to
 * its default on its own, validation never throws, and every output key is present
 * (`undefined` when absent), so a raw value the schema refused never shows through the
 * router's merge of the location search with the validated one.
 */
import type { SearchMiddleware } from '@tanstack/react-router';
import { z } from 'zod';

import { safeReturnPath } from '../lib/return-path.js';

/** A query string longer than this is ignored whole, before it is decoded. */
const MAX_SEARCH_LENGTH = 8192;

/** Keys that could reach an object prototype; they are dropped while parsing. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parses a query string into a null-prototype object of raw strings. A repeated key
 * becomes an array of its values, which no schema accepts, so it falls back.
 */
export function parseSearch(searchStr: string): Record<string, unknown> {
  const search: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const query = searchStr.startsWith('?') ? searchStr.slice(1) : searchStr;
  if (query.length > MAX_SEARCH_LENGTH) return search;

  for (const [key, value] of new URLSearchParams(query)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const previous = search[key];
    if (previous === undefined) search[key] = value;
    else if (Array.isArray(previous)) previous.push(value);
    else search[key] = [previous, value];
  }
  return search;
}

/** Serializes the primitive values of a search object; `undefined` and objects are left out. */
export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export const SORT_FIELDS = ['identifier', 'title', 'updatedAt'] as const;
export const SORT_ORDERS = ['asc', 'desc'] as const;
export const PAGE_SIZES = [25, 50, 100] as const;
export const ENTITY_TABS = ['details', 'related'] as const;

/** `CatalogLimits`: the longest cursor and search query the API accepts. */
export const MAX_CURSOR_LENGTH = 512;
export const MAX_QUERY_LENGTH = 100;

export type PageSize = (typeof PAGE_SIZES)[number];

const DEFAULT_PAGE_SIZE: PageSize = 50;

/**
 * The defaults of the table and entity search. The router strips them from the URL, so
 * a canonical URL holds only what the user chose and a `returnTo` path keeps its own
 * query (D12, task 5.8).
 */
export const TABLE_SEARCH_DEFAULTS = {
  sort: 'identifier',
  order: 'asc',
  pageSize: DEFAULT_PAGE_SIZE,
} as const satisfies {
  sort: (typeof SORT_FIELDS)[number];
  order: (typeof SORT_ORDERS)[number];
  pageSize: PageSize;
};

export const ENTITY_SEARCH_DEFAULTS = {
  tab: 'details',
} as const satisfies { tab: (typeof ENTITY_TABS)[number] };

/** One of `values`, else `fallback`; optional on input so a link may omit it. */
function oneOf<const T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) {
  return z.enum(values).default(fallback).catch(fallback);
}

/** A string of at most `max` characters, else absent. `max` is the only check made. */
function boundedText(max: number) {
  return z.string().max(max).optional().catch(undefined);
}

/** A page size, as a number (a link) or as its text (the URL), else 50. */
const pageSize = z
  .union([z.literal(PAGE_SIZES), z.enum(['25', '50', '100'])])
  .default(DEFAULT_PAGE_SIZE)
  .catch(DEFAULT_PAGE_SIZE)
  .transform((value): PageSize =>
    typeof value === 'number' ? value : (Number(value) as PageSize),
  );

/** `/catalog/$blueprint`: the `entities.list` sort, order, page size and cursor. */
export const tableSearchSchema = z
  .object({
    sort: oneOf(SORT_FIELDS, TABLE_SEARCH_DEFAULTS.sort),
    order: oneOf(SORT_ORDERS, TABLE_SEARCH_DEFAULTS.order),
    pageSize,
    cursor: boundedText(MAX_CURSOR_LENGTH),
  })
  .transform(({ sort, order, pageSize: size, cursor }) => ({
    sort,
    order,
    pageSize: size,
    cursor,
  }));

/** `/catalog/$blueprint/$entity`: the open tab. */
export const entitySearchSchema = z
  .object({ tab: oneOf(ENTITY_TABS, ENTITY_SEARCH_DEFAULTS.tab) })
  .transform(({ tab }) => ({ tab }));

/** `/search`: the query, kept as text. */
export const searchPageSearchSchema = z
  .object({ q: boundedText(MAX_QUERY_LENGTH) })
  .transform(({ q }) => ({ q }));

/**
 * The `error` of the Visma Connect return (Q72): `sso` when the raw value is exactly
 * `sso`, or a list whose first value is `sso`, because Better Auth appends its own code
 * to `errorCallbackURL`. Anything else is absent; the appended code is never kept.
 */
const ssoError = z
  .unknown()
  .transform((value): 'sso' | undefined => {
    const first: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
    return first === 'sso' ? 'sso' : undefined;
  })
  .optional();

/** A raw `returnTo`, later passed through `safeReturnPath`; anything but text is absent. */
const rawReturnTo = z.string().optional().catch(undefined);

/**
 * `/sign-in`: where to go after signing in, always through `safeReturnPath`, and whether
 * the page is the Visma Connect error return.
 */
export const signInSearchSchema = z
  .object({ returnTo: rawReturnTo, error: ssoError })
  .transform(({ returnTo, error }) => ({ returnTo: safeReturnPath(returnTo), error }));

/**
 * `/change-password`: where to go once the temporary password is changed (Q73), always
 * through `safeReturnPath`.
 */
export const changePasswordSearchSchema = z
  .object({ returnTo: rawReturnTo })
  .transform(({ returnTo }) => ({ returnTo: safeReturnPath(returnTo) }));

/** The search middleware `next` with its metadata, as the router's own middlewares call it. */
type NextWithMeta = (
  search: SignInSearch,
  collectMeta: true,
) => { search: SignInSearch; meta: { explicit?: unknown } };

/**
 * Leaves the default `returnTo` of `/sign-in` out of its URL, unless the navigation gave
 * it explicitly. The router writes the validated search back on load, so without this a
 * plain `/sign-in` became `/sign-in?returnTo=%2F` (task 6.2); the session gate's redirect
 * passes `returnTo: '/'` explicitly and keeps it (Q65).
 */
export const omitDefaultReturnTo: SearchMiddleware<SignInSearch> = ({ search, next }) => {
  const { search: result, meta } = (next as unknown as NextWithMeta)(search, true);
  const { explicit } = meta;
  const explicitReturnTo =
    typeof explicit === 'object' && explicit !== null && Object.hasOwn(explicit, 'returnTo');
  if (result.returnTo !== '/' || explicitReturnTo) return result;
  const withoutReturnTo: Partial<SignInSearch> = { ...result };
  delete withoutReturnTo.returnTo;
  return withoutReturnTo as SignInSearch;
};

export type TableSearch = z.output<typeof tableSearchSchema>;
export type EntitySearch = z.output<typeof entitySearchSchema>;
export type SearchPageSearch = z.output<typeof searchPageSearchSchema>;
export type SignInSearch = z.output<typeof signInSearchSchema>;
export type ChangePasswordSearch = z.output<typeof changePasswordSearchSchema>;
