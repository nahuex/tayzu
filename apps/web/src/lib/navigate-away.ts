/**
 * The app's one way off its own origin (design D11 and Q72). It lives in its own module
 * so that tests can replace it: jsdom's `location.assign` can be neither replaced nor
 * spied on. It makes no check of its own: callers validate the URL first (for example
 * with `isAbsoluteHttpsUrl` of `./external-url.js`).
 */
export function navigateToExternal(url: string): void {
  window.location.assign(url);
}
