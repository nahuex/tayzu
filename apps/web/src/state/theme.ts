/**
 * The theme store (design D12, Theme and State; spec "The app is localized and themed").
 *
 * `system` (the default), `light` or `dark`, stored in `localStorage` under
 * `tayzu.theme`. `/theme-init.js` (source: `./theme-init.js`) applies the stored choice
 * before first paint with the same rule; this store keeps `<html>` in step afterwards.
 * The `dark` class on `<html>` drives Tailwind's `dark` variant (`src/index.css`).
 * Storage that throws never breaks the app: the choice then holds for the session.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand';

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = 'tayzu.theme';

const DEFAULT_THEME: Theme = 'system';
const DARK_CLASS = 'dark';
const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

export interface ThemeState {
  theme: Theme;
  /** Sets the choice, applies it to `<html>` and stores it (best effort). */
  setTheme: (theme: Theme) => void;
}

export type ThemeStore = UseBoundStore<StoreApi<ThemeState>>;

function isTheme(value: unknown): value is Theme {
  return (THEMES as readonly unknown[]).includes(value);
}

/** The stored choice when it is exactly one of `THEMES`, else the default. */
function readStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function writeStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable: the choice holds for this session only.
  }
}

/** The dark color-scheme query, or `undefined` where `matchMedia` is missing or throws. */
function darkSchemeQuery(): MediaQueryList | undefined {
  try {
    return window.matchMedia(DARK_SCHEME_QUERY);
  } catch {
    return undefined;
  }
}

function applyTheme(theme: Theme, prefersDark: boolean): void {
  const dark = theme === 'dark' || (theme === 'system' && prefersDark);
  document.documentElement.classList.toggle(DARK_CLASS, dark);
}

/**
 * A new theme store, applied to `<html>` at once. While the theme is `system`, `<html>`
 * follows changes of the operating system's color scheme. The listener lives as long as
 * the page, like the store itself.
 */
export function createThemeStore(): ThemeStore {
  const darkScheme = darkSchemeQuery();
  const prefersDark = (): boolean => darkScheme?.matches ?? false;
  const initialTheme = readStoredTheme();

  const store = create<ThemeState>()((set) => ({
    theme: initialTheme,
    setTheme(theme) {
      set({ theme });
      applyTheme(theme, prefersDark());
      writeStoredTheme(theme);
    },
  }));

  applyTheme(initialTheme, prefersDark());
  darkScheme?.addEventListener('change', () => {
    const { theme } = store.getState();
    if (theme === 'system') applyTheme(theme, prefersDark());
  });

  return store;
}
