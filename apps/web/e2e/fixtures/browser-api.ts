/**
 * Reads of the app's API from inside the page (003 tasks 10.2 and 10.3). Playwright's
 * Node request context (`page.request`) does not trust the run's throwaway CA, and the
 * suite never tells anything to ignore TLS errors (D16), so a spec that needs to check
 * an answer the UI does not show asks the page to `fetch` it, same-origin, with the
 * page's own cookies, exactly as the app would.
 *
 * Only the status and the parsed JSON body come back; nothing is logged.
 */
import type { Page } from '@playwright/test';

export interface BrowserAnswer {
  readonly status: number;
  /** The parsed JSON body, or `null` for an empty or non-JSON one. */
  readonly body: unknown;
}

/** A same-origin `GET` of `path` (a path, never a URL) from the page. */
export async function apiGet(page: Page, path: string): Promise<BrowserAnswer> {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('apiGet takes an absolute path of the app.');
  }
  const answer: unknown = await page.evaluate(
    `fetch(${JSON.stringify(path)}, { credentials: 'same-origin' }).then(async (response) => ({
      status: response.status,
      body: await response.json().catch(() => null),
    }))`,
  );
  return answer as BrowserAnswer;
}
