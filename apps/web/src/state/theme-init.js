/**
 * Applies the stored theme before first paint (design D12 and Q46).
 *
 * A classic script, loaded by `index.html` as the blocking external
 * `<script src="/theme-init.js">` in `<head>`, so `script-src 'self'` needs no
 * nonce or hash. The `tayzu:theme-init` plugin of `vite.config.ts` minifies this
 * file and emits it, with no comment, as `theme-init.js` at the build root.
 *
 * It follows the same rule as the theme store (`./theme.ts`): the stored
 * `tayzu.theme` when it is exactly `system`, `light` or `dark`, else `system`;
 * the `dark` class on `<html>` is present for `dark`, or for `system` while the
 * operating system prefers a dark color scheme. Storage or `matchMedia` that
 * throws never stops the page: the theme falls back to `system`, then to light.
 */
(function applyStoredTheme() {
  try {
    let theme = 'system';
    try {
      const stored = window.localStorage.getItem('tayzu.theme');
      if (stored === 'system' || stored === 'light' || stored === 'dark') theme = stored;
    } catch {
      // Storage unavailable: keep the default.
    }

    let dark = theme === 'dark';
    if (theme === 'system') {
      try {
        dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      } catch {
        // No `matchMedia`: light.
      }
    }

    document.documentElement.classList.toggle('dark', dark);
  } catch {
    // Never block the page: the theme store applies the theme once the app starts.
  }
})();
