/**
 * 003 task 10.8 (design D10, D16 and Resolved decisions Q15, Q92, Q93): no Content
 * Security Policy violation anywhere, against the stack of `scripts/ci/e2e.sh`, through
 * the shared fixture.
 *
 * "Using the app raises no policy violation": in the light and in the dark theme (the
 * browser's color scheme, with no stored choice, so the app follows the system), the
 * tour of `fixtures/app-tour.ts` visits every route and opens every dialog. The shared
 * fixture records every `securitypolicyviolation` event of every document and every
 * request to another origin; each test asserts both lists empty after the tour. Only the
 * Visma Connect test lets the browser reach the OIDC stub's origin, which that flow
 * needs (D16); any other origin still fails it.
 *
 * The runtime `<style>` record (D10). The style nonce stays only if the app inserts a
 * `<style>` element at runtime (Radix's scroll lock, through `react-style-singleton`).
 * An init script watches every document for `<style>` elements and reports each one:
 * the tour stop, the path, whether it carries a nonce, whether that nonce is the one the
 * page's `tayzu-style-nonce` meta holds, its attribute names, its first selector, and
 * how many rules the browser applied. No nonce value is ever kept. Each test publishes
 * its record three ways:
 *
 * - an annotation `runtime-style-elements` whose description is a JSON summary
 *   (`{"inserted":N,"withPageNonce":N,"withoutNonce":N,"applied":N}`);
 * - an attachment `runtime-style-elements.json` with every element;
 * - the run's file `$E2E_STATE_DIR/runtime-style-record.json` (mode 0600, next to the
 *   seed file), which holds every test's elements by title and a summary
 *   (`anyRuntimeStyleElement`), and is reset when the seed file is newer.
 *
 * Every runtime `<style>` element must carry the page's nonce: the spec allows one only
 * through that nonce, and `style-src` refuses any other.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { BrowserContext, Page, TestInfo } from '@playwright/test';

import {
  SIGN_IN_BUDGET,
  THEMES,
  expectTheme,
  tourGatePages,
  tourPublicPages,
  tourSignedInPages,
  tourVismaConnectStepUp,
  type Checkpoint,
  type Theme,
} from './fixtures/app-tour.js';
import { expect, seedFilePath, settle, test, type PageGuard } from './fixtures/test.js';

const STYLE_BINDING = '__tayzuStyleElement';
const RECORD_FILE_NAME = 'runtime-style-record.json';

/**
 * Runs in every document before its own scripts: reports every `<style>` element added
 * to the document, at any depth, with no nonce value.
 */
const STYLE_WATCHER = `(() => {
  const seen = new WeakSet();
  const report = (element) => {
    if (seen.has(element)) return;
    seen.add(element);
    const binding = window[${JSON.stringify(STYLE_BINDING)}];
    if (typeof binding !== 'function') return;
    const meta = document.querySelector('meta[name="tayzu-style-nonce"]');
    const pageNonce = meta === null ? '' : meta.getAttribute('content') || '';
    const nonce = typeof element.nonce === 'string' ? element.nonce : '';
    const css = element.textContent || '';
    let rules = -1;
    try {
      rules = element.sheet === null ? -1 : element.sheet.cssRules.length;
    } catch {
      rules = -1;
    }
    void binding({
      origin: window.location.origin,
      path: window.location.pathname,
      parent:
        element.parentNode === document.head
          ? 'head'
          : element.parentNode === document.body
            ? 'body'
            : 'other',
      hasNonce: nonce !== '',
      nonceMatchesPage: nonce !== '' && nonce === pageNonce,
      attributes: element.getAttributeNames().filter((name) => name !== 'nonce'),
      firstSelector: (css.split('{')[0] || '').trim().slice(0, 80),
      cssLength: css.length,
      appliedRules: rules,
      whileParsing: document.readyState === 'loading',
    });
  };
  const visit = (node) => {
    if (node.nodeType !== 1) return;
    if (node.localName === 'style') report(node);
    for (const child of node.querySelectorAll('style')) report(child);
  };
  new MutationObserver((mutations) => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) visit(node);
  }).observe(document, { childList: true, subtree: true });
})();`;

/** One `<style>` element the page inserted, as the watcher reported it. */
interface StyleElementRecord {
  readonly theme: Theme;
  /**
   * The last tour stop reached before the element appeared, `(start)` before the first:
   * the element belongs to the step that follows that stop.
   */
  readonly after: string;
  /** The document's origin: the app's, or the OIDC stub's in the Visma Connect test. */
  readonly origin: string;
  readonly path: string;
  readonly parent: string;
  readonly hasNonce: boolean;
  readonly nonceMatchesPage: boolean;
  readonly attributes: readonly string[];
  readonly firstSelector: string;
  readonly cssLength: number;
  /** The rules the browser applied from it; `-1` when it has no sheet. */
  readonly appliedRules: number;
  readonly whileParsing: boolean;
}

interface StyleWatch {
  readonly elements: StyleElementRecord[];
  /** The tour's checkpoint: lets the page settle, then names the next stretch. */
  readonly checkpoint: Checkpoint;
  readonly stops: string[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Installs the watcher on every document of the context, before the first navigation. */
async function watchStyleElements(
  context: BrowserContext,
  page: Page,
  theme: Theme,
): Promise<StyleWatch> {
  const elements: StyleElementRecord[] = [];
  const stops: string[] = [];
  let after = '(start)';
  await context.exposeBinding(STYLE_BINDING, (_source, raw: unknown) => {
    const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    elements.push({
      theme,
      after,
      origin: text(record['origin']),
      path: text(record['path']),
      parent: text(record['parent']),
      hasNonce: record['hasNonce'] === true,
      nonceMatchesPage: record['nonceMatchesPage'] === true,
      attributes: Array.isArray(record['attributes'])
        ? record['attributes'].map((name) => text(name))
        : [],
      firstSelector: text(record['firstSelector']),
      cssLength: typeof record['cssLength'] === 'number' ? record['cssLength'] : 0,
      appliedRules: typeof record['appliedRules'] === 'number' ? record['appliedRules'] : -1,
      whileParsing: record['whileParsing'] === true,
    });
  });
  await context.addInitScript({ content: STYLE_WATCHER });
  return {
    elements,
    stops,
    async checkpoint(label) {
      // The tour waited for what is on screen; the reports already queued arrive here.
      await page.waitForLoadState('load');
      await settle(page);
      stops.push(label);
      after = label;
    },
  };
}

interface StyleSummary {
  readonly inserted: number;
  readonly withPageNonce: number;
  readonly withoutNonce: number;
  readonly applied: number;
}

function summarize(elements: readonly StyleElementRecord[]): StyleSummary {
  return {
    inserted: elements.length,
    withPageNonce: elements.filter((element) => element.nonceMatchesPage).length,
    withoutNonce: elements.filter((element) => !element.hasNonce).length,
    applied: elements.filter((element) => element.appliedRules > 0).length,
  };
}

interface RunRecord {
  /** The seed file's modification time: one value per `e2e.sh up`. */
  readonly run: number;
  readonly tests: Record<string, readonly StyleElementRecord[]>;
  readonly anyRuntimeStyleElement: boolean;
  readonly summary: StyleSummary;
}

/** Publishes a test's record: annotation, attachment, and the run's file. */
async function publishStyleRecord(watch: StyleWatch, testInfo: TestInfo): Promise<void> {
  const summary = summarize(watch.elements);
  testInfo.annotations.push({
    type: 'runtime-style-elements',
    description: JSON.stringify(summary),
  });
  await testInfo.attach('runtime-style-elements.json', {
    body: JSON.stringify({ summary, stops: watch.stops, elements: watch.elements }, null, 2),
    contentType: 'application/json',
  });

  const seedFile = seedFilePath();
  const run = statSync(seedFile).mtimeMs;
  const path = join(dirname(seedFile), RECORD_FILE_NAME);
  let tests: Record<string, readonly StyleElementRecord[]> = {};
  if (existsSync(path)) {
    const previous = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunRecord>;
    if (previous.run === run && previous.tests !== undefined) tests = { ...previous.tests };
  }
  tests[testInfo.titlePath.slice(1).join(' > ')] = watch.elements;
  const all = Object.values(tests).flat();
  const record: RunRecord = {
    run,
    tests,
    anyRuntimeStyleElement: all.length > 0,
    summary: summarize(all),
  };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/**
 * THEN the browser reports no CSP violation, no request went to another origin, and
 * every runtime `<style>` element of the app carried the page's nonce.
 */
async function expectNoPolicyViolation(
  page: Page,
  appOrigin: string,
  guard: PageGuard,
  watch: StyleWatch,
): Promise<void> {
  await settle(page);
  expect(guard.cspViolations, 'no securitypolicyviolation event').toEqual([]);
  expect(guard.unexpectedRequests, 'no request to another origin').toEqual([]);
  expect(
    watch.elements.filter((element) => element.origin === appOrigin && !element.nonceMatchesPage),
    "every runtime <style> element carries the page's nonce",
  ).toEqual([]);
}

/** The document answer carries the enforced policy, so "no violation" means something. */
async function expectEnforcedPolicy(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  const policy = response?.headers()['content-security-policy'] ?? '';
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain('style-src');
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ locale: 'en-US', colorScheme: theme });

    test.describe('public pages', () => {
      test.use({ signInBudget: SIGN_IN_BUDGET.publicPages });

      test(`Using the app raises no policy violation: public pages, ${theme} theme`, async ({
        context,
        page,
        seed,
        guard,
      }, testInfo) => {
        test.setTimeout(90_000);
        const watch = await watchStyleElements(context, page, theme);
        try {
          await expectEnforcedPolicy(page, '/sign-in');
          await expectTheme(page, theme);
          await tourPublicPages(page, seed, guard, watch.checkpoint);
          await expectTheme(page, theme);
        } finally {
          await publishStyleRecord(watch, testInfo);
        }
        await expectNoPolicyViolation(page, seed.appOrigin, guard, watch);
      });
    });

    test.describe('gate pages', () => {
      test.use({ signInBudget: SIGN_IN_BUDGET.gatePages });

      test(`Using the app raises no policy violation: gate pages, ${theme} theme`, async ({
        context,
        page,
        seed,
        guard,
      }, testInfo) => {
        const watch = await watchStyleElements(context, page, theme);
        try {
          await expectEnforcedPolicy(page, '/sign-in');
          await tourGatePages(page, context, seed, watch.checkpoint);
          await expectTheme(page, theme);
        } finally {
          await publishStyleRecord(watch, testInfo);
        }
        await expectNoPolicyViolation(page, seed.appOrigin, guard, watch);
      });
    });

    test.describe('signed-in pages', () => {
      test.use({ signInBudget: SIGN_IN_BUDGET.signedInPages });

      test(`Using the app raises no policy violation: signed-in pages and dialogs, ${theme} theme`, async ({
        context,
        page,
        seed,
        guard,
      }, testInfo) => {
        test.setTimeout(90_000);
        // GIVEN a signed-in user (the tour signs `dialogOwner` in)
        const watch = await watchStyleElements(context, page, theme);
        try {
          await expectEnforcedPolicy(page, '/sign-in');
          // WHEN they visit every page of the app, and open every dialog
          await tourSignedInPages(page, seed, guard, watch.checkpoint);
          await expectTheme(page, theme);
        } finally {
          await publishStyleRecord(watch, testInfo);
        }
        // THEN the browser reports no CSP violation and makes no request to another origin
        await expectNoPolicyViolation(page, seed.appOrigin, guard, watch);
      });
    });

    test.describe('Visma Connect step-up dialog', () => {
      test.use({ allowOidcOrigin: true, signInBudget: SIGN_IN_BUDGET.vismaConnect });

      test(`Using the app raises no policy violation: Visma Connect step-up dialog, ${theme} theme`, async ({
        context,
        page,
        seed,
        guard,
      }, testInfo) => {
        test.setTimeout(60_000);
        const watch = await watchStyleElements(context, page, theme);
        try {
          await expectEnforcedPolicy(page, '/sign-in');
          await tourVismaConnectStepUp(page, seed, guard, watch.checkpoint);
          await expectTheme(page, theme);
        } finally {
          await publishStyleRecord(watch, testInfo);
        }
        await expectNoPolicyViolation(page, seed.appOrigin, guard, watch);
      });
    });
  });
}
