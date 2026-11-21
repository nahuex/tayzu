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
 * - any `4xx` or `5xx` answer from the app's origin that the test did not declare;
 * - any request to an origin other than the app's https origin (`seed.appOrigin`) and,
 *   only for a test that sets `allowOidcOrigin`, the OIDC stub's (`seed.oidcOrigin`).
 *
 * Expected error answers (Resolved decision Q92). Chromium writes its own console error,
 * "Failed to load resource: the server responded with a status of N (...)", for every
 * error answer, including the ones a spec requires (the gate's `401` from `GET /v1/me`,
 * a step-up `403`, a not-found `404`). A test declares the ones its flow requires as
 * `status + path` pairs, with the `expectedApiErrors` option (`test.use`) or with
 * `guard.expectApiError(status, path)` before the action (for a path read from the
 * seed). Only a declared pair, a `4xx`, on the app's own origin, exempts both its answer
 * and Chromium's line for it; the path is the exact pathname, with no query. An
 * undeclared `4xx`, any `5xx`, an error answer of another origin and any other console
 * error still fail the test. A declared pair may occur any number of times.
 *
 * How a console line is tied to its answer: Chromium's line carries the resource's URL
 * as its location, and the status in its text, so the pair is read from the line itself.
 * A line without a usable location is tied to an answer through the `response` events
 * instead: every error answer of the context is recorded, in order, and such a line
 * takes the oldest answer not yet taken with the same status. Both are classified when
 * the test ends, after every page has settled, so the order in which Playwright
 * delivers the `console` and `response` events does not matter. A line that matches no
 * answer, or an answer of an undeclared pair, stays an error.
 *
 * What it records keeps origins and paths only, never a query, a fragment or a value,
 * because a report can outlive the run (it is uploaded on failure, D2).
 *
 * It also exposes the run's seed file (`seed`, and `readSeed` for code outside a test)
 * and the TOTP code of a seeded factor (`totpCode`).
 *
 * Sign-in pacing (`./sign-in-pace.ts`): the API's production limit of 10 local sign-ins
 * per minute and client IP applies to the whole suite, which reaches the API from one
 * address. The context records every sign-in request in the run's ledger, and before a
 * test starts the fixture waits until the trailing minute leaves room for the sign-ins
 * the test declares (`signInBudget`, one by default), extending the test's timeout by
 * the wait. A test that signs in more than once declares it with `test.use`.
 */
import { expect, test as base, type Page } from '@playwright/test';

import { readSeed, seedFilePath, type E2eSeed } from './seed-file.js';
import { recordSignIns, SIGN_IN_PATH, signInWaitMs } from './sign-in-pace.js';

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

/** An error answer a test expects from the app's own origin (Q92): a `4xx` and a pathname. */
export interface ExpectedApiError {
  readonly status: number;
  /** The exact pathname, `/v1/me`; no origin, query or fragment. */
  readonly path: string;
}

/** What the fixture collected during one test; a spec may assert on it directly too. */
export interface PageGuard {
  readonly cspViolations: CspViolation[];
  /**
   * Console errors and uncaught errors. Chromium's resource-error lines are added when
   * the test ends, unless a declared pair exempts them (Q92).
   */
  readonly consoleErrors: string[];
  /** Error answers of the app's origin that no declared pair covers, as `status origin+path`. */
  readonly unexpectedErrorAnswers: string[];
  /** The declared answers that did occur, as `status origin+path`, filled when the test ends. */
  readonly expectedErrorAnswers: string[];
  readonly unexpectedRequests: string[];
  /** Declares one more expected error answer of this test (Q92); call it before the action. */
  readonly expectApiError: (status: number, path: string) => void;
}

export interface E2eOptions {
  /** Lets requests reach the OIDC stub's origin, for the Visma Connect flows only. */
  readonly allowOidcOrigin: boolean;
  /** The error answers the test's flow requires (Q92); none by default. */
  readonly expectedApiErrors: readonly ExpectedApiError[];
  /** The local sign-ins the test makes at most, for the pacing of `./sign-in-pace.ts`; one by default. */
  readonly signInBudget: number;
}

export interface E2eFixtures {
  readonly seed: E2eSeed;
  readonly guard: PageGuard;
  /** Waits, before the test, for room in the sign-in limit's trailing window (automatic). */
  readonly signInPace: undefined;
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

/** The pairs each guard's test declared: the option's, then `expectApiError`'s. */
const DECLARED = new WeakMap<PageGuard, ExpectedApiError[]>();

/** Chromium's console line for an error answer: no page code writes it. */
const RESOURCE_ERROR = /^Failed to load resource: the server responded with a status of (\d{3})\b/;

/** A declaration is checked when it is made: a malformed one is a spec bug. */
function checkedExpectation(status: number, path: string): ExpectedApiError {
  if (!Number.isInteger(status) || status < 400 || status > 499) {
    throw new Error('An expected API error is a 4xx status: a 5xx always fails the test.');
  }
  if (!path.startsWith('/') || path.startsWith('//') || /[?#]/.test(path)) {
    throw new Error('An expected API error names an exact pathname, without query or fragment.');
  }
  return { status, path };
}

/** `origin` and `pathname` of a URL, or `undefined` when it does not parse. */
function originAndPath(raw: string): { origin: string; path: string } | undefined {
  try {
    const url = new URL(raw);
    return { origin: url.origin, path: url.pathname };
  } catch {
    return undefined;
  }
}

/** One error answer of the context, as the `response` event reported it. */
interface ErrorAnswer {
  readonly status: number;
  readonly url: string;
  /** Set once a console line without a usable location is tied to this answer. */
  taken: boolean;
}

/** One Chromium resource-error line, classified when the test ends. */
interface ResourceErrorLine {
  readonly status: number;
  readonly line: string;
  readonly url: string;
}

/**
 * The end-of-test classification of Q92: every recorded error answer and every
 * resource-error line goes either to the expected list or to a failing one.
 */
function classifyErrorAnswers(params: {
  readonly appOrigin: string;
  readonly expected: readonly ExpectedApiError[];
  readonly answers: ErrorAnswer[];
  readonly lines: readonly ResourceErrorLine[];
  readonly guard: PageGuard;
}): void {
  const { appOrigin, expected, answers, lines, guard } = params;
  const isDeclared = (status: number, url: string): boolean => {
    const parsed = originAndPath(url);
    return (
      parsed !== undefined &&
      parsed.origin === appOrigin &&
      expected.some((pair) => pair.status === status && pair.path === parsed.path)
    );
  };

  for (const answer of answers) {
    const parsed = originAndPath(answer.url);
    if (parsed?.origin !== appOrigin) continue;
    const entry = `${String(answer.status)} ${withoutSecrets(answer.url)}`;
    if (isDeclared(answer.status, answer.url)) guard.expectedErrorAnswers.push(entry);
    else guard.unexpectedErrorAnswers.push(entry);
  }

  for (const line of lines) {
    let url = line.url;
    if (originAndPath(url) === undefined) {
      // No usable location: the oldest answer not yet taken with the same status.
      const answer = answers.find(
        (candidate) => !candidate.taken && candidate.status === line.status,
      );
      if (answer !== undefined) {
        answer.taken = true;
        url = answer.url;
      }
    }
    if (!isDeclared(line.status, url)) {
      guard.consoleErrors.push(`${line.line} at ${withoutSecrets(url)}`);
    }
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
  expectedApiErrors: [[], { option: true }],
  signInBudget: [1, { option: true }],

  signInPace: [
    async ({ signInBudget }, provide, testInfo) => {
      const wait = signInWaitMs(signInBudget);
      if (wait > 0) {
        testInfo.setTimeout(testInfo.timeout + wait);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      await provide(undefined);
    },
    { auto: true },
  ],

  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixture's dependencies from this pattern
  seed: async ({}, provide) => {
    await provide(readSeed());
  },

  guard: async ({ expectedApiErrors }, provide) => {
    const declared = expectedApiErrors.map(({ status, path }) => checkedExpectation(status, path));
    const guard: PageGuard = {
      cspViolations: [],
      consoleErrors: [],
      unexpectedErrorAnswers: [],
      expectedErrorAnswers: [],
      unexpectedRequests: [],
      expectApiError(status, path) {
        declared.push(checkedExpectation(status, path));
      },
    };
    DECLARED.set(guard, declared);
    await provide(guard);
  },

  context: async ({ context, seed, guard, allowOidcOrigin }, provide) => {
    const allowed = new Set([seed.appOrigin, ...(allowOidcOrigin ? [seed.oidcOrigin] : [])]);
    const answers: ErrorAnswer[] = [];
    const lines: ResourceErrorLine[] = [];

    await context.exposeBinding(CSP_BINDING, (_source, violation: unknown) => {
      guard.cspViolations.push(toViolation(violation));
    });
    await context.addInitScript({ content: CSP_LISTENER });
    context.on('console', (message) => {
      if (message.type() !== 'error') return;
      const status = RESOURCE_ERROR.exec(message.text())?.[1];
      if (status === undefined) {
        guard.consoleErrors.push(`${message.text()} at ${withoutSecrets(message.location().url)}`);
        return;
      }
      // The status text is Chromium's own ("Unauthorized"), never a server string.
      lines.push({ status: Number(status), line: message.text(), url: message.location().url });
    });
    context.on('response', (response) => {
      if (response.status() < 400 || !isNetworkRequest(response.url())) return;
      answers.push({ status: response.status(), url: response.url(), taken: false });
    });
    context.on('weberror', (webError) => {
      guard.consoleErrors.push(`uncaught: ${webError.error().name}: ${webError.error().message}`);
    });
    context.on('request', (request) => {
      const url = request.url();
      if (!isNetworkRequest(url)) return;
      const target = new URL(url);
      if (
        request.method() === 'POST' &&
        target.origin === seed.appOrigin &&
        target.pathname === SIGN_IN_PATH
      ) {
        recordSignIns([Date.now()]);
      }
      if (!allowed.has(target.origin)) {
        guard.unexpectedRequests.push(`${request.method()} ${withoutSecrets(url)}`);
      }
    });

    await provide(context);

    for (const page of context.pages()) await settle(page);
    classifyErrorAnswers({
      appOrigin: seed.appOrigin,
      // The option's pairs and those `guard.expectApiError` added during the test.
      expected: DECLARED.get(guard) ?? [],
      answers,
      lines,
      guard,
    });
    expect.soft(guard.cspViolations, 'no securitypolicyviolation event').toEqual([]);
    expect.soft(guard.consoleErrors, 'no console error').toEqual([]);
    expect
      .soft(guard.unexpectedErrorAnswers, 'no undeclared error answer of the app (Q92)')
      .toEqual([]);
    expect.soft(guard.unexpectedRequests, 'no request to an unexpected origin').toEqual([]);
  },
});
