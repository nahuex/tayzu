/**
 * i18n (design D12 and Q10, Q66; spec "The app is localized and themed").
 *
 * i18next with the `common`, `auth`, `catalog` and `search` namespaces in `en`
 * and `es`. Each locale file is its own Vite chunk, loaded through a dynamic
 * `import()` by a small in-bundle backend (same origin, no HTTP backend). Only
 * `common` loads at start; a page asks for the others.
 *
 * The locale is the stored choice (`localStorage` `tayzu.locale`, exactly `en`
 * or `es`), else `navigator.language` reduced to its language, else `en`.
 * Storage that throws never breaks the app (D12, State).
 */
import { createInstance } from 'i18next';
import type { BackendModule, i18n as I18n, LoggerModule, ReadCallback } from 'i18next';

export const LOCALES = ['en', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

export const NAMESPACES = ['common', 'auth', 'catalog', 'search'] as const;
export type Namespace = (typeof NAMESPACES)[number];

export const LOCALE_STORAGE_KEY = 'tayzu.locale';

const FALLBACK_LOCALE: Locale = 'en';

/** The namespace every page needs, loaded before the app renders. */
const INITIAL_NAMESPACE: Namespace = 'common';

/** One lazy loader per locale file, keyed `./locales/<lng>/<ns>.json`. */
const LOCALE_LOADERS: Record<string, (() => Promise<unknown>) | undefined> = import.meta.glob(
  './locales/*/*.json',
  { import: 'default' },
);

function isLocale(value: unknown): value is Locale {
  return (LOCALES as readonly unknown[]).includes(value);
}

function isNamespace(value: unknown): value is Namespace {
  return (NAMESPACES as readonly unknown[]).includes(value);
}

function storedLocale(): Locale | undefined {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function browserLocale(): Locale | undefined {
  try {
    const language = navigator.language.split('-')[0]?.toLowerCase();
    return isLocale(language) ? language : undefined;
  } catch {
    return undefined;
  }
}

/** The stored choice, else `navigator.language` reduced to `en` or `es`, else `en`. */
export function resolveLocale(): Locale {
  return storedLocale() ?? browserLocale() ?? FALLBACK_LOCALE;
}

/** What a backend hands i18next: the parsed locale file. */
type ResourceData = Parameters<ReadCallback>[1];

/** Loads a locale file through its own dynamic `import()`; unknown pairs fail closed. */
const localeBackend: BackendModule = {
  type: 'backend',
  callbackApi: true,
  init() {
    // Nothing to configure: the loaders are fixed at build time.
  },
  read(language: string, namespace: string, callback: ReadCallback) {
    const load =
      isLocale(language) && isNamespace(namespace)
        ? LOCALE_LOADERS[`./locales/${language}/${namespace}.json`]
        : undefined;
    if (load === undefined) {
      callback(new Error('Unknown locale or namespace'), false);
      return;
    }
    load().then(
      (data) => {
        callback(null, data as ResourceData);
      },
      () => {
        callback(new Error('A locale file failed to load'), false);
      },
    );
  },
};

/** The app has no client logging (D15), so i18next's own messages go nowhere. */
const silentLogger: LoggerModule = {
  type: 'logger',
  log() {
    // Intentionally empty.
  },
  warn() {
    // Intentionally empty.
  },
  error() {
    // Intentionally empty.
  },
};

function setDocumentLanguage(locale: Locale): void {
  document.documentElement.lang = locale;
}

/**
 * A new i18next instance (never the global one) in `resolveLocale()`'s locale,
 * with `common` loaded. It stores nothing: only the selector stores a choice.
 */
export async function createI18n(): Promise<I18n> {
  const locale = resolveLocale();
  const i18n = createInstance().use(localeBackend).use(silentLogger);
  await i18n.init({
    lng: locale,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...LOCALES],
    ns: [INITIAL_NAMESPACE],
    defaultNS: INITIAL_NAMESPACE,
  });
  setDocumentLanguage(locale);
  return i18n;
}

/** The locale selector's action: store the choice, switch, and update `<html lang>`. */
export async function changeLocale(i18n: I18n, locale: Locale): Promise<void> {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage unavailable: the choice holds for this session only.
  }
  await i18n.changeLanguage(locale);
  setDocumentLanguage(locale);
}

/** A blueprint or property `{ en, es? }` text in `locale`, with `en` as the fallback. */
export function localizedText(text: { en: string; es?: string }, locale: Locale): string {
  return locale === 'es' ? (text.es ?? text.en) : text.en;
}

/** The locale an instance shows: its resolved language when that is `es`, else `en`. */
export function currentLocale(i18n: I18n): Locale {
  return isLocale(i18n.resolvedLanguage) ? i18n.resolvedLanguage : FALLBACK_LOCALE;
}
