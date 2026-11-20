/**
 * The theme (task 5.6, design D12 and Q46; spec "The app is localized and themed",
 * scenario "Storage unavailable").
 *
 * D12 (Theme): "`system` (default), `light` or `dark`, stored in `localStorage`
 * (`tayzu.theme`); `/theme-init.js` sets the `dark` class on `<html>` before first paint,
 * and the Zustand store keeps it in step. Tailwind's `dark` variant does the rest."
 * D12 (State): "Every `localStorage` and `sessionStorage` access is wrapped in
 * `try`/`catch` and the app works when storage throws." Spec: "The app MUST offer a light
 * theme, a dark theme and the system preference, apply the stored choice before the first
 * paint without inline script, and keep working when browser storage is unavailable."
 * `src/index.css` keys dark mode on the class: `@custom-variant dark (&:is(.dark *))`.
 *
 * Assumed API of `./theme.js` (`src/state/theme.ts`, D1: `state/` holds the Zustand
 * stores):
 *
 * ```ts
 * import type { StoreApi, UseBoundStore } from 'zustand';
 *
 * export const THEMES: readonly ['system', 'light', 'dark'];
 * export type Theme = (typeof THEMES)[number];
 * export const THEME_STORAGE_KEY: 'tayzu.theme';
 *
 * export interface ThemeState {
 *   theme: Theme;
 *   // Sets the choice, applies it to `<html>` and stores it under `tayzu.theme`
 *   // (`dark` and `light` exactly as written; `system` as `system` or by removing the
 *   // key). A throwing storage is ignored: the choice holds for the session.
 *   setTheme: (theme: Theme) => void;
 * }
 * export type ThemeStore = UseBoundStore<StoreApi<ThemeState>>;
 *
 * // A new Zustand store (`create`), never a module-level singleton, and no side effect
 * // at import. Its initial `theme` is the stored `tayzu.theme` when it is exactly
 * // `system`, `light` or `dark`, else `system`. On creation it applies the theme to
 * // `<html>` (the `dark` class present exactly when the theme is `dark`, or `system`
 * // while `window.matchMedia('(prefers-color-scheme: dark)')` matches), and it follows
 * // that query's `change` events while the theme is `system`. Never throws, also when
 * // `window.localStorage`, `getItem` or `setItem` throws.
 * export function createThemeStore(): ThemeStore;
 * ```
 *
 * Assumed API of `../app/theme-toggle.js` (`src/app/theme-toggle.tsx`, the header's
 * theme toggle of D12, built on the shadcn `DropdownMenu` of `src/components/ui`):
 *
 * ```tsx
 * // A button whose accessible name is `common:theme.label` ("Theme", "Tema") opening a
 * // menu of three `menuitemradio` items named `common:theme.system`, `.light` and
 * // `.dark`, the current choice `aria-checked="true"`. Choosing one calls `setTheme`.
 * // Texts come from react-i18next (`useTranslation('common')`).
 * export function ThemeToggle(props: { store: ThemeStore }): React.JSX.Element;
 * ```
 *
 * `theme-init.js` (Q46): its commented source is `src/state/theme-init.js`, a classic
 * script (no `import` or `export`) that the `vite.config.ts` plugin minifies and emits
 * unhashed at the build root (`theme-init-build.test.ts` covers the emitted file). This
 * test evaluates the source, read through Vite's `?raw` import, in jsdom: a `<script>`
 * element is appended to `<head>` and jsdom runs it synchronously, so every assertion
 * right after it is what the first paint sees. The script reads `tayzu.theme` with the
 * same rule as the store, inside `try`/`catch`, and sets the `dark` class on `<html>`.
 *
 * jsdom runs script elements in its own global, which is not the test's `window`
 * (`document`, the storage area and `Storage.prototype` are shared). The helper
 * `scriptWindow()` gets that global, so the test can install `matchMedia` and make the
 * `localStorage` getter throw for the script as well as for the app code.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeToggle } from '../app/theme-toggle.js';
import { createI18n } from '../i18n/i18n.js';
import { THEMES, THEME_STORAGE_KEY, createThemeStore, type ThemeStore } from './theme.js';
import themeInitSource from './theme-init.js?raw';

const DARK_QUERY = '(prefers-color-scheme: dark)';

type BrowserWindow = Window & typeof globalThis;

/** A `MediaQueryList` stand-in; only the exact dark-scheme query ever matches. */
interface FakeMediaQueryList {
  readonly media: string;
  readonly matches: boolean;
  onchange: ((event: Event) => void) | null;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
  addListener: (listener: (event: Event) => void) => void;
  removeListener: (listener: (event: Event) => void) => void;
  dispatchEvent: (event: Event) => boolean;
}

interface ColorSchemePreference {
  setPrefersDark: (prefersDark: boolean) => void;
}

const SCRIPT_WINDOW_EVENT = 'tayzu-test-script-window';

/** The global jsdom runs `<script>` elements in (see the header). */
function scriptWindow(): BrowserWindow {
  let captured: BrowserWindow | undefined;
  const listener = (event: Event): void => {
    captured = (event as CustomEvent<BrowserWindow>).detail;
  };
  document.addEventListener(SCRIPT_WINDOW_EVENT, listener);
  appendScript(
    `document.dispatchEvent(new CustomEvent('${SCRIPT_WINDOW_EVENT}', { detail: window }));`,
  );
  document.removeEventListener(SCRIPT_WINDOW_EVENT, listener);
  if (captured === undefined) throw new Error('jsdom did not run the probe script');
  return captured;
}

function appendScript(source: string): void {
  const script = document.createElement('script');
  script.textContent = source;
  document.head.append(script);
  script.remove();
}

let scriptGlobal: BrowserWindow;
let scriptErrors: unknown[];
const recordScriptError = (event: ErrorEvent): void => {
  scriptErrors.push(event.error ?? event.message);
};

/** Evaluates `theme-init.js` as the browser does: a classic script, before first paint. */
function runThemeInit(): void {
  appendScript(themeInitSource);
}

/** Installs `matchMedia` on the app's window and on the script global. */
function installColorScheme(prefersDark: boolean): ColorSchemePreference {
  let dark = prefersDark;
  const darkLists: FakeMediaQueryList[] = [];
  const listeners = new Map<FakeMediaQueryList, Set<(event: Event) => void>>();

  function matchMedia(query: string): FakeMediaQueryList {
    const own = new Set<(event: Event) => void>();
    const list: FakeMediaQueryList = {
      media: query,
      get matches() {
        return query === DARK_QUERY && dark;
      },
      onchange: null,
      addEventListener(type, listener) {
        if (type === 'change') own.add(listener);
      },
      removeEventListener(type, listener) {
        if (type === 'change') own.delete(listener);
      },
      addListener(listener) {
        own.add(listener);
      },
      removeListener(listener) {
        own.delete(listener);
      },
      dispatchEvent() {
        return true;
      },
    };
    listeners.set(list, own);
    if (query === DARK_QUERY) darkLists.push(list);
    return list;
  }

  for (const target of [window, scriptGlobal]) {
    Object.defineProperty(target, 'matchMedia', {
      configurable: true,
      writable: true,
      value: matchMedia,
    });
  }

  return {
    setPrefersDark(next) {
      if (next === dark) return;
      dark = next;
      for (const list of darkLists) {
        const event = Object.assign(new Event('change'), { matches: next, media: DARK_QUERY });
        list.onchange?.(event);
        for (const listener of listeners.get(list) ?? []) listener(event);
      }
    },
  };
}

function storageDenied(): never {
  throw new DOMException('The operation is insecure.', 'SecurityError');
}

function denyStorageMethods(...methods: ('getItem' | 'setItem' | 'removeItem')[]): void {
  for (const method of methods) {
    vi.spyOn(Storage.prototype, method).mockImplementation(storageDenied);
  }
}

/** Reading `window.localStorage` itself throws, for the app and for the script. */
function denyLocalStorageGetter(): void {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(storageDenied);
  vi.spyOn(scriptGlobal, 'localStorage', 'get').mockImplementation(storageDenied);
}

function store(value: string): void {
  window.localStorage.setItem('tayzu.theme', value);
}

function stored(): string | null {
  return window.localStorage.getItem('tayzu.theme');
}

function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

function stubNavigatorLanguage(language: string): void {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
}

async function renderToggle(themeStore: ThemeStore): Promise<void> {
  const i18n = await createI18n();
  render(
    <I18nextProvider i18n={i18n}>
      <ThemeToggle store={themeStore} />
    </I18nextProvider>,
  );
}

async function chooseTheme(
  user: ReturnType<typeof userEvent.setup>,
  menuName: string,
  itemName: string,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: menuName }));
  await user.click(await screen.findByRole('menuitemradio', { name: itemName }));
}

/** Opens the menu, checks that `itemName` is the one checked item, and closes it. */
async function expectChecked(
  user: ReturnType<typeof userEvent.setup>,
  menuName: string,
  itemName: string,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: menuName }));
  expect(
    await screen.findByRole('menuitemradio', { name: itemName, checked: true }),
  ).toBeInTheDocument();
  expect(screen.getAllByRole('menuitemradio', { checked: true })).toHaveLength(1);
  await user.keyboard('{Escape}');
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.lang = '';
  scriptGlobal = scriptWindow();
  scriptErrors = [];
  scriptGlobal.addEventListener('error', recordScriptError);
});

afterEach(() => {
  scriptGlobal.removeEventListener('error', recordScriptError);
  vi.restoreAllMocks();
  for (const target of [window, scriptGlobal]) {
    Reflect.deleteProperty(target, 'matchMedia');
  }
  window.localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.lang = '';
});

describe('the theme choices and their storage key', () => {
  it('offers system, light and dark, stored under tayzu.theme', () => {
    expect([...THEMES]).toEqual(['system', 'light', 'dark']);
    expect(THEME_STORAGE_KEY).toBe('tayzu.theme');
  });
});

describe('the theme store', () => {
  it('defaults to system when nothing is stored, and stores nothing by itself', () => {
    installColorScheme(false);

    const themeStore = createThemeStore();

    expect(themeStore.getState().theme).toBe('system');
    expect(isDark()).toBe(false);
    expect(stored()).toBeNull();
  });

  it('applies the dark class on creation for system with a dark preference', () => {
    installColorScheme(true);

    const themeStore = createThemeStore();

    expect(themeStore.getState().theme).toBe('system');
    expect(isDark()).toBe(true);
  });

  it.each([
    ['dark', false, true],
    ['light', true, false],
    ['system', true, true],
    ['system', false, false],
  ] as const)(
    'reads a stored %s at creation (dark preference %s) and keeps <html> in step',
    (choice, prefersDark, dark) => {
      installColorScheme(prefersDark);
      store(choice);

      const themeStore = createThemeStore();

      expect(themeStore.getState().theme).toBe(choice);
      expect(isDark()).toBe(dark);
    },
  );

  it.each(['DARK', 'Dark', ' dark', 'dark ', 'auto', '', '"dark"', '{"theme":"dark"}'])(
    'treats the invalid stored value %j as system',
    (value) => {
      installColorScheme(false);
      store(value);

      const themeStore = createThemeStore();

      expect(themeStore.getState().theme).toBe('system');
      expect(isDark()).toBe(false);
    },
  );

  it('sets dark: the dark class even under a light preference, stored as dark', () => {
    installColorScheme(false);
    const themeStore = createThemeStore();

    themeStore.getState().setTheme('dark');

    expect(themeStore.getState().theme).toBe('dark');
    expect(isDark()).toBe(true);
    expect(stored()).toBe('dark');
  });

  it('sets light: no dark class even under a dark preference, stored as light', () => {
    installColorScheme(true);
    const themeStore = createThemeStore();
    expect(isDark()).toBe(true);

    themeStore.getState().setTheme('light');

    expect(themeStore.getState().theme).toBe('light');
    expect(isDark()).toBe(false);
    expect(stored()).toBe('light');
  });

  it('sets system: the class follows the preference, and the next start reads system', () => {
    installColorScheme(true);
    store('light');
    const themeStore = createThemeStore();
    expect(isDark()).toBe(false);

    themeStore.getState().setTheme('system');

    expect(themeStore.getState().theme).toBe('system');
    expect(isDark()).toBe(true);
    expect(['system', null]).toContain(stored());
    expect(createThemeStore().getState().theme).toBe('system');
  });

  it('is read back by the next store, as a reload would', () => {
    installColorScheme(false);
    createThemeStore().getState().setTheme('dark');
    document.documentElement.className = '';

    const next = createThemeStore();

    expect(next.getState().theme).toBe('dark');
    expect(isDark()).toBe(true);
  });

  it('follows a change of the system preference while the theme is system', () => {
    const scheme = installColorScheme(false);
    const themeStore = createThemeStore();
    expect(isDark()).toBe(false);

    scheme.setPrefersDark(true);
    expect(isDark()).toBe(true);

    scheme.setPrefersDark(false);
    expect(isDark()).toBe(false);
    expect(themeStore.getState().theme).toBe('system');
  });

  it('ignores a change of the system preference while the theme is light or dark', () => {
    const scheme = installColorScheme(false);
    const themeStore = createThemeStore();

    themeStore.getState().setTheme('light');
    scheme.setPrefersDark(true);
    expect(isDark()).toBe(false);

    themeStore.getState().setTheme('dark');
    scheme.setPrefersDark(false);
    expect(isDark()).toBe(true);

    themeStore.getState().setTheme('system');
    expect(isDark()).toBe(false);
    scheme.setPrefersDark(true);
    expect(isDark()).toBe(true);
  });
});

describe('the theme toggle', () => {
  it('switches between the three choices by role and localized name (en)', async () => {
    stubNavigatorLanguage('en-US');
    installColorScheme(false);
    const user = userEvent.setup();
    const themeStore = createThemeStore();
    await renderToggle(themeStore);

    await expectChecked(user, 'Theme', 'System');
    await user.click(screen.getByRole('button', { name: 'Theme' }));
    expect(await screen.findByRole('menuitemradio', { name: 'System' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
    await user.keyboard('{Escape}');

    await chooseTheme(user, 'Theme', 'Dark');
    expect(themeStore.getState().theme).toBe('dark');
    expect(isDark()).toBe(true);
    expect(stored()).toBe('dark');
    await expectChecked(user, 'Theme', 'Dark');

    await chooseTheme(user, 'Theme', 'Light');
    expect(themeStore.getState().theme).toBe('light');
    expect(isDark()).toBe(false);
    expect(stored()).toBe('light');
    await expectChecked(user, 'Theme', 'Light');

    await chooseTheme(user, 'Theme', 'System');
    expect(themeStore.getState().theme).toBe('system');
    expect(isDark()).toBe(false);
    await expectChecked(user, 'Theme', 'System');
  });

  it('uses the Spanish labels in a Spanish browser', async () => {
    stubNavigatorLanguage('es-AR');
    installColorScheme(true);
    const user = userEvent.setup();
    const themeStore = createThemeStore();
    await renderToggle(themeStore);

    expect(screen.queryByRole('button', { name: 'Theme' })).not.toBeInTheDocument();
    await expectChecked(user, 'Tema', 'Sistema');
    await user.click(screen.getByRole('button', { name: 'Tema' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Claro' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Oscuro' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await chooseTheme(user, 'Tema', 'Claro');

    expect(themeStore.getState().theme).toBe('light');
    expect(isDark()).toBe(false);
    await expectChecked(user, 'Tema', 'Claro');
  });

  it('shows the stored choice as checked', async () => {
    stubNavigatorLanguage('en-US');
    installColorScheme(false);
    store('dark');
    const user = userEvent.setup();
    await renderToggle(createThemeStore());

    await expectChecked(user, 'Theme', 'Dark');
  });
});

describe('theme-init.js, evaluated in jsdom before first paint', () => {
  it('reports a script error through the harness (self-check)', () => {
    appendScript('throw new Error("harness self-check");');

    expect(scriptErrors).toHaveLength(1);
  });

  it('is a classic script: no import or export statement', () => {
    expect(themeInitSource.trim()).not.toBe('');
    expect(themeInitSource).not.toMatch(/^\s*(import|export)\b/m);
  });

  it('applies a stored dark under a light preference', () => {
    installColorScheme(false);
    store('dark');

    runThemeInit();

    expect(isDark()).toBe(true);
    expect(scriptErrors).toEqual([]);
  });

  it('applies a stored light under a dark preference', () => {
    installColorScheme(true);
    store('light');

    runThemeInit();

    expect(isDark()).toBe(false);
    expect(scriptErrors).toEqual([]);
  });

  it.each([
    [true, true],
    [false, false],
  ])('follows the preference for a stored system (dark preference %s)', (prefersDark, dark) => {
    installColorScheme(prefersDark);
    store('system');

    runThemeInit();

    expect(isDark()).toBe(dark);
    expect(scriptErrors).toEqual([]);
  });

  it.each([
    [true, true],
    [false, false],
  ])('follows the preference when nothing is stored (dark preference %s)', (prefersDark, dark) => {
    installColorScheme(prefersDark);

    runThemeInit();

    expect(isDark()).toBe(dark);
    expect(scriptErrors).toEqual([]);
  });

  it.each([
    ['DARK', true, true],
    ['DARK', false, false],
    ['auto', true, true],
    [' dark', false, false],
    ['"dark"', false, false],
    ['light ', true, true],
  ] as const)(
    'treats the invalid stored value %j as system (dark preference %s)',
    (value, prefersDark, dark) => {
      installColorScheme(prefersDark);
      store(value);

      runThemeInit();

      expect(isDark()).toBe(dark);
      expect(scriptErrors).toEqual([]);
    },
  );

  it.each(['dark', 'light', 'system'] as const)(
    'reads the %s the store stored, as on the next page load',
    (choice) => {
      installColorScheme(true);
      createThemeStore().getState().setTheme(choice);
      document.documentElement.className = '';

      runThemeInit();

      expect(isDark()).toBe(choice !== 'light');
      expect(scriptErrors).toEqual([]);
    },
  );

  it('agrees with the store created after it', () => {
    installColorScheme(false);
    store('dark');

    runThemeInit();
    expect(isDark()).toBe(true);
    const themeStore = createThemeStore();

    expect(themeStore.getState().theme).toBe('dark');
    expect(isDark()).toBe(true);
  });
});

describe('Storage unavailable', () => {
  it('GIVEN storage that throws on every access, WHEN the user opens the app and changes the theme, THEN the app works and the theme changes for the session', async () => {
    // GIVEN a browser whose storage throws on every access
    denyLocalStorageGetter();
    denyStorageMethods('getItem', 'setItem', 'removeItem');
    stubNavigatorLanguage('en-US');
    installColorScheme(false);
    const user = userEvent.setup();

    // WHEN the user opens the app ...
    runThemeInit();
    expect(scriptErrors).toEqual([]);
    expect(isDark()).toBe(false);
    let themeStore: ThemeStore | undefined;
    expect(() => {
      themeStore = createThemeStore();
    }).not.toThrow();
    if (themeStore === undefined) throw new Error('createThemeStore returned nothing');
    expect(themeStore.getState().theme).toBe('system');
    await renderToggle(themeStore);

    // ... AND changes the theme
    await chooseTheme(user, 'Theme', 'Dark');

    // THEN the app works and the theme changes for the session
    expect(themeStore.getState().theme).toBe('dark');
    expect(isDark()).toBe(true);
    await expectChecked(user, 'Theme', 'Dark');

    await chooseTheme(user, 'Theme', 'Light');
    expect(themeStore.getState().theme).toBe('light');
    expect(isDark()).toBe(false);
  });

  it('the store falls back to system when getItem throws', () => {
    denyStorageMethods('getItem');
    installColorScheme(true);

    const themeStore = createThemeStore();

    expect(themeStore.getState().theme).toBe('system');
    expect(isDark()).toBe(true);
  });

  it('the store falls back to system when reading window.localStorage throws', () => {
    denyLocalStorageGetter();
    installColorScheme(true);

    const themeStore = createThemeStore();

    expect(themeStore.getState().theme).toBe('system');
    expect(isDark()).toBe(true);
  });

  it('the store still changes the theme for the session when setItem throws', () => {
    installColorScheme(false);
    const themeStore = createThemeStore();
    denyStorageMethods('setItem', 'removeItem');

    expect(() => {
      themeStore.getState().setTheme('dark');
    }).not.toThrow();
    expect(themeStore.getState().theme).toBe('dark');
    expect(isDark()).toBe(true);

    expect(() => {
      themeStore.getState().setTheme('system');
    }).not.toThrow();
    expect(themeStore.getState().theme).toBe('system');
    expect(isDark()).toBe(false);
  });

  it('the store still changes the theme for the session when reading window.localStorage throws', () => {
    installColorScheme(false);
    const themeStore = createThemeStore();
    denyLocalStorageGetter();

    expect(() => {
      themeStore.getState().setTheme('dark');
    }).not.toThrow();
    expect(themeStore.getState().theme).toBe('dark');
    expect(isDark()).toBe(true);
  });

  it.each([
    [true, true],
    [false, false],
  ])(
    'theme-init.js follows the preference without an error when getItem throws (dark preference %s)',
    (prefersDark, dark) => {
      denyStorageMethods('getItem');
      installColorScheme(prefersDark);

      runThemeInit();

      expect(scriptErrors).toEqual([]);
      expect(isDark()).toBe(dark);
    },
  );

  it.each([
    [true, true],
    [false, false],
  ])(
    'theme-init.js follows the preference without an error when reading window.localStorage throws (dark preference %s)',
    (prefersDark, dark) => {
      denyLocalStorageGetter();
      installColorScheme(prefersDark);

      runThemeInit();

      expect(scriptErrors).toEqual([]);
      expect(isDark()).toBe(dark);
    },
  );
});
