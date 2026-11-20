/**
 * Reading an authentication page's validated route search (design D15 and Q71, Q73).
 */
import { safeReturnPath } from '../lib/return-path.js';

/**
 * One own field of the route's search. The search is read as `unknown` (the hook is typed
 * `any` inside the tree the router type comes from), so each field is checked again.
 */
export function searchField(search: unknown, key: string): unknown {
  return typeof search === 'object' && search !== null && Object.hasOwn(search, key)
    ? (search as Record<string, unknown>)[key]
    : undefined;
}

/** The route's `returnTo`, failing closed on `/`. */
export function returnToOf(search: unknown): string {
  return safeReturnPath(searchField(search, 'returnTo'));
}
