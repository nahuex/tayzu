/**
 * What the search page and the command dialog share (design D14, Q89, Q90): the result
 * and blueprint types, the API's shortest query, and the blueprint title of a result.
 */
import type { ApiClient } from '../api/client.js';
import { localizedText, type Locale } from '../i18n/i18n.js';

export type SearchItem = Awaited<ReturnType<ApiClient['search']['entities']>>['items'][number];
export type Blueprint = Awaited<ReturnType<ApiClient['blueprints']['list']>>['items'][number];

/** The shortest query the API accepts, after trimming and NFC normalization. */
export const MIN_QUERY_LENGTH = 2;

/** The length of `q` as the server counts it: trimmed and NFC-normalized. */
export function countedLength(q: string): number {
  return q.trim().normalize('NFC').length;
}

/** A blueprint's localized title, or its identifier when the sidebar list lacks it. */
export function blueprintTitle(
  blueprints: readonly Blueprint[] | undefined,
  identifier: string,
  locale: Locale,
): string {
  const found = blueprints?.find((blueprint) => blueprint.identifier === identifier);
  return found === undefined ? identifier : localizedText(found.title, locale);
}
