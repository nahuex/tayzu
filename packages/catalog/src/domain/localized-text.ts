/**
 * Localized text (spec, "Blueprint definition"): an object keyed by
 * supported locale, `en` required. Used for blueprint and relation titles
 * and descriptions.
 */
import { CatalogError } from './errors.js';

export interface LocalizedText {
  en: string;
  es?: string;
}

const SUPPORTED_LOCALES = ['en', 'es'] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

function isSupportedLocale(locale: string): locale is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidLocale(path: string): never {
  throw new CatalogError('CATALOG_VALIDATION_FAILED', 'Localized text is invalid', {
    issues: [{ path, message: 'Localized text is invalid' }],
  });
}

/**
 * `path` is the JSON Pointer of the localized-text field itself (for
 * example `/title`); a per-locale issue is reported at `${path}/${locale}`.
 * `maxLength` is the caller-supplied per-locale character limit.
 */
export function parseLocalizedText(value: unknown, path: string, maxLength: number): LocalizedText {
  if (!isRecord(value)) invalidLocale(`${path}/en`);

  const en = value['en'];
  if (typeof en !== 'string' || en.length > maxLength) invalidLocale(`${path}/en`);

  const result: LocalizedText = { en };

  for (const locale of Object.keys(value)) {
    if (locale === 'en') continue;

    if (!isSupportedLocale(locale)) invalidLocale(`${path}/${locale}`);

    const localeValue = value[locale];
    if (typeof localeValue !== 'string' || localeValue.length > maxLength) {
      invalidLocale(`${path}/${locale}`);
    }

    result[locale] = localeValue;
  }

  return result;
}
