/**
 * Dates and numbers through `Intl` (design D12, D13 and Q66).
 *
 * No `timeZone` is passed, so dates show in the browser's own time zone.
 */
import type { Locale } from '../i18n/i18n.js';

/** A date and time, `value` being an ISO 8601 string (as the API returns it) or a `Date`. */
export function formatDate(value: string | Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    typeof value === 'string' ? new Date(value) : value,
  );
}

/** A number with the locale's default grouping and decimals. */
export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(value);
}
