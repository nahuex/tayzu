/**
 * i18n and formatting (task 5.5, design D12 and Q10; spec "The app is localized and
 * themed", scenario "Spanish browser, no choice stored").
 *
 * D12: "i18next with namespaces `common`, `auth`, `catalog` and `search`, the `en` and
 * `es` resources bundled and split per namespace through dynamic `import()` (Vite
 * chunks, same origin, no HTTP backend). The locale is the stored choice, else
 * `navigator.language` reduced to `en` or `es`, else `en`. The selector stores it in
 * `localStorage` (`tayzu.locale`), and `<html lang>` follows it. A key-parity test keeps
 * `es` complete. Blueprint and property titles and descriptions use their `{ en, es? }`
 * value with `en` as the fallback. Dates use `Intl.DateTimeFormat` in the browser's time
 * zone; numbers use `Intl.NumberFormat`." D12 (State): "Every `localStorage` and
 * `sessionStorage` access is wrapped in `try`/`catch` and the app works when storage
 * throws."
 *
 * Locale files (D1): `src/i18n/locales/<lng>/<ns>.json`, one file per locale and
 * namespace, each a JSON object whose leaves are non-empty strings (nesting allowed).
 *
 * Assumed API of `./i18n.js`:
 *
 * ```ts
 * import type { i18n as I18n } from 'i18next';
 *
 * export const LOCALES: readonly ['en', 'es'];
 * export type Locale = (typeof LOCALES)[number];
 * export const NAMESPACES: readonly ['common', 'auth', 'catalog', 'search'];
 * export type Namespace = (typeof NAMESPACES)[number];
 * export const LOCALE_STORAGE_KEY: 'tayzu.locale';
 *
 * // The stored choice (`localStorage['tayzu.locale']`, only `en` or `es` counts), else
 * // `navigator.language` reduced to its language (`es-AR` is `es`), else `en`. Reads
 * // the browser's own `window.localStorage` and `navigator.language`; never throws,
 * // also when `window.localStorage` or `getItem` throws.
 * export function resolveLocale(): Locale;
 *
 * // A new i18next instance (never the global one) in `resolveLocale()`'s locale,
 * // `fallbackLng` `en`, with the `common` namespace loaded and every other namespace
 * // loaded only when requested, each through its own dynamic `import()` of
 * // `./locales/<lng>/<ns>.json`. Sets `document.documentElement.lang` to the locale.
 * export function createI18n(): Promise<I18n>;
 *
 * // The selector's action: stores `locale` under `tayzu.locale` (a throwing storage
 * // is ignored), switches the instance to it and sets `<html lang>` to it.
 * export function changeLocale(i18n: I18n, locale: Locale): Promise<void>;
 *
 * // `{ en, es? }` in `locale`, with `en` as the fallback.
 * export function localizedText(text: { en: string; es?: string }, locale: Locale): string;
 * ```
 *
 * Assumed API of `../lib/format.js` (D1: `lib/` holds formatting):
 *
 * ```ts
 * import type { Locale } from '../i18n/i18n.js';
 *
 * // `Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })`, with no
 * // `timeZone` option, so the browser's time zone applies. `value` is an ISO 8601
 * // string (as the API returns it) or a `Date`.
 * export function formatDate(value: string | Date, locale: Locale): string;
 *
 * // `Intl.NumberFormat(locale)` with its default options.
 * export function formatNumber(value: number, locale: Locale): string;
 * ```
 *
 * "A date in a fixed time zone": the test fixes the browser's own time zone by setting
 * `process.env.TZ` (Node re-reads it and Intl's default zone follows), so the formatter
 * is checked against the real default zone and must not pass a `timeZone` of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDate, formatNumber } from '../lib/format.js';
import {
  LOCALE_STORAGE_KEY,
  LOCALES,
  NAMESPACES,
  changeLocale,
  createI18n,
  localizedText,
  resolveLocale,
} from './i18n.js';

/** Every locale file, keyed by its path relative to this file (`./locales/es/auth.json`). */
const LOCALE_FILES: Record<string, unknown> = import.meta.glob('./locales/*/*.json', {
  eager: true,
  import: 'default',
});

const EXPECTED_LOCALES = ['en', 'es'] as const;
const EXPECTED_NAMESPACES = ['common', 'auth', 'catalog', 'search'] as const;

/** The CLDR plural suffixes i18next appends to a key (`items_one`, `items_many`, ...). */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

const INTERPOLATION = /\{\{\s*([^}\s,]+)[^}]*\}\}/g;

/** `process.env` without Node types (browser code is typechecked with `lib` DOM only). */
const processEnv = (
  globalThis as unknown as { process: { env: Record<string, string | undefined> } }
).process.env;

function localeFile(lng: string, ns: string): unknown {
  return LOCALE_FILES[`./locales/${lng}/${ns}.json`];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flattens a locale file into `dotted.key -> leaf value`. */
function flatten(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!isPlainObject(value)) return out;
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(nested)) {
      for (const [k, v] of flatten(nested, path)) out.set(k, v);
    } else {
      out.set(path, nested);
    }
  }
  return out;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(INTERPOLATION)].map((match) => match[1] ?? '').sort();
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** Plural base key -> the plural categories present for it. */
function pluralGroups(keys: Iterable<string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const match = PLURAL_SUFFIX.exec(key);
    if (match === null) continue;
    const base = key.slice(0, match.index);
    groups.set(base, [...(groups.get(base) ?? []), match[1] ?? '']);
  }
  return groups;
}

/** A key without its plural suffix; non-plural keys are unchanged. */
function baseKey(key: string): string {
  return key.replace(PLURAL_SUFFIX, '');
}

function stubNavigatorLanguage(language: string): void {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
}

function storageDenied(): never {
  throw new DOMException('The operation is insecure.', 'SecurityError');
}

function setTimeZone(zone: string): void {
  processEnv['TZ'] = zone;
}

let originalTimeZone: string | undefined;

beforeEach(() => {
  originalTimeZone = processEnv['TZ'];
  window.localStorage.clear();
  document.documentElement.lang = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.lang = '';
  if (originalTimeZone === undefined) {
    delete processEnv['TZ'];
  } else {
    processEnv['TZ'] = originalTimeZone;
  }
});

describe('the supported locales, namespaces and storage key', () => {
  it('offers en and es, the four namespaces of D12, and the tayzu.locale key', () => {
    expect([...LOCALES]).toEqual([...EXPECTED_LOCALES]);
    expect([...NAMESPACES]).toEqual([...EXPECTED_NAMESPACES]);
    expect(LOCALE_STORAGE_KEY).toBe('tayzu.locale');
  });
});

describe('Spanish browser, no choice stored', () => {
  it('GIVEN es-AR and no stored choice, WHEN the app opens, THEN it is in Spanish and <html lang> is es', async () => {
    // GIVEN a browser whose language is `es-AR` and no stored choice
    stubNavigatorLanguage('es-AR');
    expect(window.localStorage.getItem('tayzu.locale')).toBeNull();

    // WHEN the user opens the app
    const i18n = await createI18n();

    // THEN the app is in Spanish ...
    expect(i18n.language).toBe('es');
    expect(i18n.resolvedLanguage).toBe('es');

    const es = flatten(localeFile('es', 'common'));
    const en = flatten(localeFile('en', 'common'));
    const plain = [...es].filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !entry[1].includes('{{') && !entry[1].includes('$t('),
    );
    expect(plain.length).toBeGreaterThan(0);
    // At least one text differs between the locales, so the check below tells them apart.
    expect(plain.some(([key, value]) => en.get(key) !== value)).toBe(true);
    for (const [key, value] of plain) {
      expect(i18n.t(key, { ns: 'common' })).toBe(value);
    }

    // ... AND the document language is `es`
    expect(document.documentElement.lang).toBe('es');
  });

  it('does not store a choice by itself', async () => {
    stubNavigatorLanguage('es-AR');

    await createI18n();

    expect(window.localStorage.getItem('tayzu.locale')).toBeNull();
  });
});

describe('the locale resolution: stored choice, else navigator.language, else en', () => {
  it.each([
    ['es-AR', 'es'],
    ['es', 'es'],
    ['es-ES', 'es'],
    ['en-US', 'en'],
    ['en', 'en'],
    ['fr-FR', 'en'],
    ['pt-BR', 'en'],
    ['', 'en'],
  ] as const)('reduces navigator.language %j to %s when nothing is stored', (language, locale) => {
    stubNavigatorLanguage(language);

    expect(resolveLocale()).toBe(locale);
  });

  it('falls back to en for a fr-FR browser, and <html lang> is en', async () => {
    stubNavigatorLanguage('fr-FR');

    const i18n = await createI18n();

    expect(i18n.language).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('lets a stored es win over an en-US browser', async () => {
    window.localStorage.setItem('tayzu.locale', 'es');
    stubNavigatorLanguage('en-US');

    expect(resolveLocale()).toBe('es');
    const i18n = await createI18n();
    expect(i18n.language).toBe('es');
    expect(document.documentElement.lang).toBe('es');
  });

  it('lets a stored en win over an es-AR browser', async () => {
    window.localStorage.setItem('tayzu.locale', 'en');
    stubNavigatorLanguage('es-AR');

    expect(resolveLocale()).toBe('en');
    const i18n = await createI18n();
    expect(i18n.language).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it.each(['fr', 'es-AR', 'ES', '', '{"locale":"es"}'])(
    'ignores the unsupported stored value %j and uses navigator.language',
    (stored) => {
      window.localStorage.setItem('tayzu.locale', stored);
      stubNavigatorLanguage('es-AR');
      expect(resolveLocale()).toBe('es');

      stubNavigatorLanguage('fr-FR');
      expect(resolveLocale()).toBe('en');
    },
  );
});

describe('storage that throws', () => {
  it('falls back to navigator.language when getItem throws, without crashing', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(storageDenied);
    stubNavigatorLanguage('es-AR');

    expect(resolveLocale()).toBe('es');
    const i18n = await createI18n();
    expect(i18n.language).toBe('es');
    expect(document.documentElement.lang).toBe('es');
  });

  it('falls back to en when getItem throws and the browser is fr-FR', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(storageDenied);
    stubNavigatorLanguage('fr-FR');

    expect(resolveLocale()).toBe('en');
    const i18n = await createI18n();
    expect(i18n.language).toBe('en');
  });

  it('falls back to navigator.language when reading window.localStorage itself throws', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(storageDenied);
    stubNavigatorLanguage('es-AR');

    expect(resolveLocale()).toBe('es');
    const i18n = await createI18n();
    expect(i18n.language).toBe('es');
    expect(document.documentElement.lang).toBe('es');
  });

  it('still switches the locale for the session when setItem throws', async () => {
    stubNavigatorLanguage('en-US');
    const i18n = await createI18n();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(storageDenied);

    await changeLocale(i18n, 'es');

    expect(i18n.language).toBe('es');
    expect(document.documentElement.lang).toBe('es');
  });
});

describe('changing the locale', () => {
  it('stores the choice under tayzu.locale and <html lang> follows it', async () => {
    stubNavigatorLanguage('en-US');
    const i18n = await createI18n();
    expect(document.documentElement.lang).toBe('en');

    await changeLocale(i18n, 'es');

    expect(window.localStorage.getItem('tayzu.locale')).toBe('es');
    expect(i18n.language).toBe('es');
    expect(document.documentElement.lang).toBe('es');

    await changeLocale(i18n, 'en');

    expect(window.localStorage.getItem('tayzu.locale')).toBe('en');
    expect(i18n.language).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('is read back as the stored choice by the next app start', async () => {
    stubNavigatorLanguage('en-US');
    await changeLocale(await createI18n(), 'es');

    const next = await createI18n();

    expect(next.language).toBe('es');
  });
});

describe('namespaces loaded per namespace', () => {
  it('loads common at start and each other namespace only when it is requested', async () => {
    stubNavigatorLanguage('es-AR');

    const i18n = await createI18n();

    expect(i18n.hasResourceBundle('es', 'common')).toBe(true);
    const commonBundle: unknown = i18n.getResourceBundle('es', 'common');
    expect(commonBundle).toEqual(localeFile('es', 'common'));
    for (const ns of ['auth', 'catalog', 'search'] as const) {
      expect(i18n.hasResourceBundle('es', ns)).toBe(false);
    }

    await i18n.loadNamespaces('search');

    const searchBundle: unknown = i18n.getResourceBundle('es', 'search');
    expect(searchBundle).toEqual(localeFile('es', 'search'));
    expect(i18n.hasResourceBundle('es', 'auth')).toBe(false);
    expect(i18n.hasResourceBundle('es', 'catalog')).toBe(false);
  });

  it.each(EXPECTED_NAMESPACES.flatMap((ns) => EXPECTED_LOCALES.map((lng) => [lng, ns] as const)))(
    'loads the %s %s namespace from its locale file',
    async (lng, ns) => {
      window.localStorage.setItem('tayzu.locale', lng);
      const i18n = await createI18n();

      await i18n.loadNamespaces(ns);

      expect(localeFile(lng, ns)).toBeDefined();
      const bundle: unknown = i18n.getResourceBundle(lng, ns);
      expect(bundle).toEqual(localeFile(lng, ns));
    },
  );

  it('returns a new instance on every call', async () => {
    stubNavigatorLanguage('en-US');
    const first = await createI18n();

    const second = await createI18n();

    expect(second).not.toBe(first);
    await changeLocale(second, 'es');
    expect(first.language).toBe('en');
  });
});

describe('the { en, es? } localized text, with en as the fallback', () => {
  it('uses es in Spanish when es is present', () => {
    expect(localizedText({ en: 'Service', es: 'Servicio' }, 'es')).toBe('Servicio');
  });

  it('falls back to en in Spanish when es is absent', () => {
    expect(localizedText({ en: 'Service' }, 'es')).toBe('Service');
  });

  it('uses en in English, also when es is present', () => {
    expect(localizedText({ en: 'Service', es: 'Servicio' }, 'en')).toBe('Service');
    expect(localizedText({ en: 'Service' }, 'en')).toBe('Service');
  });
});

describe('dates through Intl in the browser time zone', () => {
  // 02:30 UTC on 1 March is still 28 February in Buenos Aires (UTC-3).
  const INSTANT = '2026-03-01T02:30:00.000Z';

  function expected(locale: string, timeZone: string, value: string): string {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(value));
  }

  /** Intl may separate the time and `PM` with a narrow no-break space. */
  function normalized(text: string): string {
    return text.replace(/[\u00a0\u202f]/g, ' ');
  }

  it('formats a date in a fixed browser time zone (America/Argentina/Buenos_Aires)', () => {
    setTimeZone('America/Argentina/Buenos_Aires');

    const en = formatDate(INSTANT, 'en');
    const es = formatDate(INSTANT, 'es');

    expect(en).toBe(expected('en', 'America/Argentina/Buenos_Aires', INSTANT));
    expect(normalized(en)).toBe('Feb 28, 2026, 11:30 PM');
    expect(es).toBe(expected('es', 'America/Argentina/Buenos_Aires', INSTANT));
    expect(normalized(es)).toBe('28 feb 2026, 23:30');
  });

  it('follows the browser time zone when it changes (Asia/Tokyo)', () => {
    setTimeZone('Asia/Tokyo');

    const en = formatDate(INSTANT, 'en');

    expect(en).toBe(expected('en', 'Asia/Tokyo', INSTANT));
    expect(normalized(en)).toBe('Mar 1, 2026, 11:30 AM');
  });

  it('accepts a Date as well as an ISO string', () => {
    setTimeZone('America/Argentina/Buenos_Aires');

    expect(formatDate(new Date(INSTANT), 'es')).toBe(formatDate(INSTANT, 'es'));
  });
});

describe('numbers through Intl.NumberFormat', () => {
  it('formats a number in each locale', () => {
    expect(formatNumber(1234567.891, 'en')).toBe('1,234,567.891');
    expect(formatNumber(1234567.891, 'es')).toBe('1.234.567,891');
    expect(formatNumber(1234567.891, 'en')).toBe(new Intl.NumberFormat('en').format(1234567.891));
    expect(formatNumber(1234567.891, 'es')).toBe(new Intl.NumberFormat('es').format(1234567.891));
  });
});

describe('key parity between en and es for every namespace', () => {
  it('has exactly one locale file per locale and namespace', () => {
    const expectedFiles = EXPECTED_LOCALES.flatMap((lng) =>
      EXPECTED_NAMESPACES.map((ns) => `./locales/${lng}/${ns}.json`),
    );

    expect(sorted(Object.keys(LOCALE_FILES))).toEqual(sorted(expectedFiles));
  });

  it.each(EXPECTED_NAMESPACES)('the %s namespace has the same keys in en and es', (ns) => {
    const en = flatten(localeFile('en', ns));
    const es = flatten(localeFile('es', ns));

    expect(isPlainObject(localeFile('en', ns))).toBe(true);
    expect(isPlainObject(localeFile('es', ns))).toBe(true);
    expect(en.size).toBeGreaterThan(0);

    // Plural forms follow each language's CLDR categories (es has `_many`, en does not),
    // so keys are compared without their plural suffix ...
    expect(sorted(new Set([...es.keys()].map(baseKey)))).toEqual(
      sorted(new Set([...en.keys()].map(baseKey))),
    );
    // ... a key is plural in both locales or in neither ...
    expect(sorted(pluralGroups(es.keys()).keys())).toEqual(sorted(pluralGroups(en.keys()).keys()));
    // ... and each plural key has every category its language needs.
    for (const [lng, keys] of [
      ['en', en],
      ['es', es],
    ] as const) {
      const categories = sorted(new Intl.PluralRules(lng).resolvedOptions().pluralCategories);
      for (const [base, present] of pluralGroups(keys.keys())) {
        expect({ lng, base, categories: sorted(present) }).toEqual({ lng, base, categories });
      }
    }
  });

  it.each(EXPECTED_NAMESPACES)(
    'every %s text is a non-empty string with the same placeholders in en and es',
    (ns) => {
      const en = flatten(localeFile('en', ns));
      const es = flatten(localeFile('es', ns));

      expect(es.size).toBeGreaterThan(0);
      for (const [lng, entries] of [
        ['en', en],
        ['es', es],
      ] as const) {
        for (const [key, value] of entries) {
          expect({ lng, key, type: typeof value }).toEqual({ lng, key, type: 'string' });
          expect({ lng, key, empty: value === '' }).toEqual({ lng, key, empty: false });
        }
      }
      for (const [key, value] of es) {
        const counterpart = en.get(key) ?? en.get(`${baseKey(key)}_other`);
        if (typeof value !== 'string' || typeof counterpart !== 'string') continue;
        expect({ key, placeholders: placeholders(value) }).toEqual({
          key,
          placeholders: placeholders(counterpart),
        });
      }
    },
  );
});
