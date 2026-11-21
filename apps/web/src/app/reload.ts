/**
 * The reload action of the error page (design D15). It lives in its own module so that
 * tests can replace it: jsdom's `location.reload` can be neither replaced nor spied on.
 */
export function reloadPage(): void {
  window.location.reload();
}
