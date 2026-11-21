/**
 * The shared fixture of every e2e spec (003 design D16, task 10.1). Specs import `test`
 * and `expect` from here, never from `@playwright/test` directly.
 *
 * It fails a test on:
 *
 * - any `securitypolicyviolation` event in any page of the test's context (an init
 *   script listens in every document and reports through a binding, so a navigation
 *   never loses one);
 * - any console error, or any uncaught page error;
 * - any request to an origin other than the app's https origin (`seed.appOrigin`) and,
 *   only for a test that sets `allowOidcOrigin`, the OIDC stub's (`seed.oidcOrigin`).
 *
 * What it records keeps origins and paths only, never a query, a fragment or a value,
 * because a report can outlive the run (it is uploaded on failure, D2).
 *
 * It also exposes the run's seed file (`seed`, and `readSeed` for code outside a test)
 * and the TOTP code of a seeded factor (`totpCode`).
 */
import { expect, test as base, type Page } from '@playwright/test';

import { readSeed, seedFilePath, type E2eSeed } from './seed-file.js';

export { expect };
export { readSeed, seedFilePath };
export type * from './seed-file.js';
/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) of a base32 secret at a Unix time in seconds. */
export { totpCode } from '../../../../scripts/ci/zap-seed.js';

export interface CspViolation {
  readonly directive: string;
  readonly blockedUri: string;
  readonly sourceFile: string;
  readonly disposition: string;
}

/** What the fixture collected during one test; a spec may assert on it directly too. */
export interface PageGuard {
  readonly cspViolations: CspViolation[];
  readonly consoleErrors: string[];
  readonly unexpectedRequests: string[];
}

export interface E2eOptions {
  /** Lets requests reach the OIDC stub's origin, for the Visma Connect flows only. */
  readonly allowOidcOrigin: boolean;
}

export interface E2eFixtures {
  readonly seed: E2eSeed;
  readonly guard: PageGuard;
}

const CSP_BINDING = '__tayzuCspViolation';

/** Runs in every document before its own scripts; Playwright's init scripts bypass the CSP. */
const CSP_LISTENER = `(() => {
  document.addEventListener('securitypolicyviolation', (event) => {
    const report = window[${JSON.stringify(CSP_BINDING)}];
    if (typeof report !== 'function') return;
    void report({
      directive: event.effectiveDirective,
      blockedUri: event.blockedURI,
      sourceFile: event.sourceFile,
      disposition: event.disposition,
    });
  }, true);
})();`;

/** `scheme://host:port/path` of a URL, without its query or fragment; the raw value is never kept. */
function withoutSecrets(raw: string): string {
  try {
    const url = new URL(raw);
    return url.origin === 'null' ? url.protocol : `${url.origin}${url.pathname}`;
  } catch {
    return raw === '' ? '' : '(unparsable)';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toViolation(raw: unknown): CspViolation {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    directive: text(record['directive']),
    // `inline`, `eval` or a URL: a URL loses its query and fragment.
    blockedUri: /^[a-z-]+$/.test(text(record['blockedUri']))
      ? text(record['blockedUri'])
      : withoutSecrets(text(record['blockedUri'])),
    sourceFile: withoutSecrets(text(record['sourceFile'])),
    disposition: text(record['disposition']),
  };
}

/** Only network schemes have an origin to check: `data:`, `blob:` and `about:` stay local. */
function isNetworkRequest(url: string): boolean {
  return url.startsWith('http:') || url.startsWith('https:') || url.startsWith('ws');
}

/**
 * Waits until the reports a page has already queued reach the binding: an evaluation
 * round trip after them. A closed page has nothing left to report.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate('0').catch(() => undefined);
}

export const test = base.extend<E2eFixtures & E2eOptions>({
  allowOidcOrigin: [false, { option: true }],

  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixture's dependencies from this pattern
  seed: async ({}, provide) => {
    await provide(readSeed());
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixture's dependencies from this pattern
  guard: async ({}, provide) => {
    await provide({ cspViolations: [], consoleErrors: [], unexpectedRequests: [] });
  },

  context: async ({ context, seed, guard, allowOidcOrigin }, provide) => {
    const allowed = new Set([seed.appOrigin, ...(allowOidcOrigin ? [seed.oidcOrigin] : [])]);

    await context.exposeBinding(CSP_BINDING, (_source, violation: unknown) => {
      guard.cspViolations.push(toViolation(violation));
    });
    await context.addInitScript({ content: CSP_LISTENER });
    context.on('console', (message) => {
      if (message.type() !== 'error') return;
      guard.consoleErrors.push(`${message.text()} at ${withoutSecrets(message.location().url)}`);
    });
    context.on('weberror', (webError) => {
      guard.consoleErrors.push(`uncaught: ${webError.error().name}: ${webError.error().message}`);
    });
    context.on('request', (request) => {
      const url = request.url();
      if (!isNetworkRequest(url)) return;
      if (!allowed.has(new URL(url).origin)) {
        guard.unexpectedRequests.push(`${request.method()} ${withoutSecrets(url)}`);
      }
    });

    await provide(context);

    for (const page of context.pages()) await settle(page);
    expect.soft(guard.cspViolations, 'no securitypolicyviolation event').toEqual([]);
    expect.soft(guard.consoleErrors, 'no console error').toEqual([]);
    expect.soft(guard.unexpectedRequests, 'no request to an unexpected origin').toEqual([]);
  },
});
