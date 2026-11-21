/**
 * 003 task 10.9 (design D16 and Resolved decisions Q90, Q92, Q93): accessibility, against
 * the stack of `scripts/ci/e2e.sh`, through the shared fixture (every test also fails on
 * a CSP violation, a console error, an undeclared error answer or a request to another
 * origin).
 *
 * "No accessibility violation on any page": in the light and in the dark theme (the
 * browser's color scheme, with no stored choice, so the app follows the system), the
 * tour of `fixtures/app-tour.ts` visits every route and opens every dialog, and at each
 * stop `@axe-core/playwright` checks the page with the WCAG 2.2 A and AA tags
 * (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`), no rule disabled and no
 * element excluded. Each stop is a soft assertion, so one run reports every violation of
 * every stop; any one fails the test. A violation is kept as its rule id, its impact and
 * the selectors of its nodes, never the nodes' HTML, which can hold a name or an email.
 *
 * Operable by keyboard alone (the requirement's first clause): one test walks the main
 * flows with the keyboard only (no click, no `fill`): sign-in, the skip link, opening a
 * blueprint from the sidebar, sorting by title and paging forward, opening an entity,
 * switching tabs, the command search (opened from the header and with `Ctrl`+`K`), and
 * the delete dialog closed with Cancel.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page, TestInfo } from '@playwright/test';

import {
  SIGN_IN_BUDGET,
  THEMES,
  entityPath,
  expectTheme,
  nextGet,
  tourGatePages,
  tourPublicPages,
  tourSignedInPages,
  tourVismaConnectStepUp,
  type Checkpoint,
  type Theme,
} from './fixtures/app-tour.js';
import { expect, test, type SeedUser } from './fixtures/test.js';

/** WCAG 2.2 A and AA, as design D16 names them. */
const WCAG_22_A_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** One axe violation at one stop: no HTML, no text of the page. */
interface ViolationRecord {
  readonly stop: string;
  readonly theme: Theme;
  readonly rule: string;
  readonly impact: string;
  readonly nodes: readonly string[];
  /** For `color-contrast`: each node's colors and ratio, as axe measured them. */
  readonly contrast: readonly ContrastData[];
  /** The nodes axe relates to the failure (for `aria-hidden-focus`, the focusable ones), as selectors. */
  readonly related: readonly string[];
}

interface ContrastData {
  readonly fgColor: string;
  readonly bgColor: string;
  readonly contrastRatio: number;
  readonly expectedContrastRatio: string;
}

/** The colors axe measured for a node, from its checks' data; nothing else is kept. */
function contrastOf(data: unknown): ContrastData | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const { fgColor, bgColor, contrastRatio, expectedContrastRatio } = record;
  if (typeof fgColor !== 'string' || typeof bgColor !== 'string') return undefined;
  return {
    fgColor,
    bgColor,
    contrastRatio: typeof contrastRatio === 'number' ? contrastRatio : 0,
    expectedContrastRatio: typeof expectedContrastRatio === 'string' ? expectedContrastRatio : '',
  };
}

interface AxeWatch {
  readonly checkpoint: Checkpoint;
  readonly violations: ViolationRecord[];
  readonly stops: string[];
}

/** Waits until no finite animation runs, so axe reads the final colors and layout. */
async function settleAnimations(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          `document.getAnimations().every((animation) =>
            animation.playState !== 'running' ||
            animation.effect === null ||
            animation.effect.getComputedTiming().iterations === Infinity)`,
        ),
      { message: 'animations settle' },
    )
    .toBe(true);
}

/** The checkpoint of the accessibility spec: axe with the WCAG 2.2 A and AA tags. */
function axeChecks(page: Page, theme: Theme): AxeWatch {
  const violations: ViolationRecord[] = [];
  const stops: string[] = [];
  return {
    violations,
    stops,
    async checkpoint(stop) {
      await settleAnimations(page);
      const results = await new AxeBuilder({ page }).withTags(WCAG_22_A_AA).analyze();
      const found = results.violations.map((violation) => ({
        stop,
        theme,
        rule: violation.id,
        impact: violation.impact ?? 'unknown',
        nodes: violation.nodes.map((node) => node.target.map(String).join(' ')),
        contrast: violation.nodes.flatMap((node) =>
          [...node.any, ...node.all, ...node.none]
            .map((check) => contrastOf(check.data))
            .filter((data): data is ContrastData => data !== undefined),
        ),
        related: violation.nodes
          .flatMap((node) => [...node.any, ...node.all, ...node.none])
          .flatMap((check) => check.relatedNodes ?? [])
          .map((related) => related.target.map(String).join(' '))
          .slice(0, 10),
      }));
      violations.push(...found);
      stops.push(stop);
      expect.soft(found, `no WCAG 2.2 A or AA violation: ${stop}, ${theme} theme`).toEqual([]);
    },
  };
}

async function publishViolations(watch: AxeWatch, testInfo: TestInfo): Promise<void> {
  testInfo.annotations.push({
    type: 'axe-violations',
    description: JSON.stringify({
      stops: watch.stops.length,
      violations: watch.violations.length,
      rules: [...new Set(watch.violations.map((violation) => violation.rule))],
    }),
  });
  await testInfo.attach('axe-violations.json', {
    body: JSON.stringify({ stops: watch.stops, violations: watch.violations }, null, 2),
    contentType: 'application/json',
  });
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ locale: 'en-US', colorScheme: theme });

    test.describe('public pages', () => {
      test.use({ signInBudget: SIGN_IN_BUDGET.publicPages });

      test(`No accessibility violation on any page: public pages, ${theme} theme`, async ({
        page,
        seed,
        guard,
      }, testInfo) => {
        test.setTimeout(120_000);
        // GIVEN the e2e stack with seeded data
        const axe = axeChecks(page, theme);
        try {
          await page.goto('/sign-in');
          await expectTheme(page, theme);
          // WHEN the accessibility check runs on every page in both themes
          await tourPublicPages(page, seed, guard, axe.checkpoint);
        } finally {
          await publishViolations(axe, testInfo);
        }
        // THEN it reports no violation
        expect(axe.violations).toEqual([]);
      });
    });

    test.describe('gate pages', () => {
      test.use({ signInBudget: SIGN_IN_BUDGET.gatePages });

      test(`No accessibility violation on any page: gate pages, ${theme} theme`, async ({
        context,
        page,
        seed,
      }, testInfo) => {
        test.setTimeout(90_000);
        const axe = axeChecks(page, theme);
        try {
          await page.goto('/sign-in');
          await expectTheme(page, theme);
          await tourGatePages(page, context, seed, axe.checkpoint);
        } finally {
          await publishViolations(axe, testInfo);
        }
        expect(axe.violations).toEqual([]);
      });
    });

    test.describe('signed-in pages', () => {
      test.use({ signInBudget: SIGN_IN_BUDGET.signedInPages });

      test(`No accessibility violation on any page: signed-in pages and dialogs, ${theme} theme`, async ({
        page,
        seed,
        guard,
      }, testInfo) => {
        test.setTimeout(180_000);
        const axe = axeChecks(page, theme);
        try {
          await page.goto('/sign-in');
          await expectTheme(page, theme);
          await tourSignedInPages(page, seed, guard, axe.checkpoint);
          await expectTheme(page, theme);
        } finally {
          await publishViolations(axe, testInfo);
        }
        expect(axe.violations).toEqual([]);
      });
    });

    test.describe('Visma Connect step-up dialog', () => {
      test.use({ allowOidcOrigin: true, signInBudget: SIGN_IN_BUDGET.vismaConnect });

      test(`No accessibility violation on any page: Visma Connect step-up dialog, ${theme} theme`, async ({
        page,
        seed,
        guard,
      }, testInfo) => {
        test.setTimeout(60_000);
        const axe = axeChecks(page, theme);
        try {
          await page.goto('/sign-in');
          await expectTheme(page, theme);
          await tourVismaConnectStepUp(page, seed, guard, axe.checkpoint);
        } finally {
          await publishViolations(axe, testInfo);
        }
        expect(axe.violations).toEqual([]);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Keyboard only
// ---------------------------------------------------------------------------

/** The most `Tab` presses a walk may take to reach one control. */
const MAX_TABS = 80;

/** The page's own view of an element: only what `isFocused` reads. */
interface FocusableElement {
  readonly ownerDocument: { readonly activeElement: unknown };
}

async function isFocused(target: Locator): Promise<boolean> {
  return target.evaluate(
    (element: FocusableElement) => element === element.ownerDocument.activeElement,
  );
}

/**
 * Presses `Tab` (or `Shift`+`Tab`) until `target` has the focus; fails when it never
 * does. `name` names the control in the failure, never a value.
 */
async function tabTo(
  page: Page,
  target: Locator,
  name: string,
  options: { readonly backward?: boolean } = {},
): Promise<void> {
  await expect(target).toBeVisible();
  const key = options.backward === true ? 'Shift+Tab' : 'Tab';
  for (let presses = 0; presses < MAX_TABS; presses += 1) {
    await page.keyboard.press(key);
    if (await isFocused(target)) return;
  }
  throw new Error(`${key} never reached ${name} within ${String(MAX_TABS)} presses.`);
}

/** Signs a user without a second factor in with the keyboard only. */
async function signInWithKeyboard(page: Page, user: SeedUser): Promise<void> {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
  await tabTo(page, page.getByLabel('Email'), 'the email field');
  await page.keyboard.type(user.email);
  await tabTo(page, page.getByLabel('Password', { exact: true }), 'the password field');
  await page.keyboard.type(user.password);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL((url) => url.pathname === '/');
  await expect(page.getByRole('navigation', { name: 'Catalog' })).toBeVisible();
}

test.describe('keyboard only', () => {
  test.use({ locale: 'en-US', colorScheme: 'light', signInBudget: 1 });

  test('The main flows work with the keyboard only', async ({ page, seed }) => {
    test.setTimeout(120_000);
    const catalog = seed.tenants.a.catalog;
    const paging = catalog.blueprints.find(
      (blueprint) => blueprint.identifier === catalog.paging.blueprint,
    );
    if (paging === undefined) throw new Error('The seed has no paging blueprint.');
    const deletes: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'DELETE') deletes.push(new URL(request.url()).pathname);
    });

    // Sign-in.
    await signInWithKeyboard(page, seed.tenants.a.users.dialogOwner);

    // The skip link moves the focus to the main region.
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await tabTo(page, skip, 'the skip link');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();

    // Opening a blueprint from the sidebar, which comes before the main region.
    const sidebarLink = page
      .getByRole('navigation', { name: 'Catalog' })
      .locator(`a[href="/catalog/${paging.identifier}"]`);
    await tabTo(page, sidebarLink, 'the sidebar link of the paging blueprint', {
      backward: true,
    });
    const listPath = `/v1/blueprints/${paging.identifier}/entities`;
    const firstLoad = nextGet(page, listPath);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL((url) => url.pathname === `/catalog/${paging.identifier}`);
    expect((await firstLoad).status()).toBe(200);
    const table = page.getByRole('table', { name: paging.title });
    await expect(page.getByRole('heading', { level: 1, name: paging.title })).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(50);

    // Sorting: the title column's button, ascending, then descending.
    const titleHeader = table.getByRole('columnheader', { name: 'Title' });
    const titleSort = titleHeader.getByRole('button', { name: 'Title', exact: true });
    await tabTo(page, titleSort, 'the title sort button');
    const ascending = nextGet(page, listPath, { sort: 'title', order: 'asc' });
    await page.keyboard.press('Enter');
    expect((await ascending).status()).toBe(200);
    await expect(titleHeader).toHaveAttribute('aria-sort', 'ascending');
    await expect(titleSort).toBeFocused();
    const descending = nextGet(page, listPath, { sort: 'title', order: 'desc' });
    await page.keyboard.press('Enter');
    expect((await descending).status()).toBe(200);
    await expect(titleHeader).toHaveAttribute('aria-sort', 'descending');

    // Paging forward.
    const next = page.getByRole('button', { name: 'Next', exact: true });
    await tabTo(page, next, 'the next-page button');
    const secondPage = nextGet(page, listPath, { sort: 'title', order: 'desc' });
    await page.keyboard.press('Enter');
    const secondAnswer = await secondPage;
    expect(secondAnswer.status()).toBe(200);
    expect(new URL(secondAnswer.url()).searchParams.has('cursor')).toBe(true);
    await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeEnabled();
    await expect(titleHeader).toHaveAttribute('aria-sort', 'descending');

    // Opening an entity: the identifier link of the page's last row, back from the pager.
    const lastRow = table.locator('tbody tr').last();
    const entityLink = lastRow.getByRole('link').first();
    const identifier = ((await entityLink.textContent()) ?? '').trim();
    expect(identifier).not.toBe('');
    const entity = catalog.entities.find(
      (candidate) =>
        candidate.blueprint === paging.identifier && candidate.identifier === identifier,
    );
    if (entity === undefined) throw new Error('The last row is not a seeded entity.');
    await tabTo(page, entityLink, 'the last row entity link', { backward: true });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL((url) => url.pathname === entityPath(entity));
    await expect(page.getByRole('heading', { level: 1, name: entity.title })).toBeVisible();

    // Switching tabs: the selected tab is one stop, and the arrow keys move between tabs.
    const details = page.getByRole('tab', { name: 'Details', exact: true });
    const related = page.getByRole('tab', { name: 'Related', exact: true });
    await expect(details).toHaveAttribute('aria-selected', 'true');
    await tabTo(page, details, 'the details tab');
    await page.keyboard.press('ArrowRight');
    await expect(related).toBeFocused();
    await expect(related).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Related' })).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(details).toBeFocused();
    await expect(details).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Details' })).toBeVisible();

    // The delete dialog, closed with Cancel: nothing is deleted, and the focus returns.
    const deleteButton = page.getByRole('button', { name: 'Delete entity' });
    await tabTo(page, deleteButton, 'the delete button');
    await page.keyboard.press('Enter');
    const confirmation = page.getByRole('dialog', { name: 'Delete this entity?' });
    await expect(confirmation).toBeVisible();
    const cancel = confirmation.getByRole('button', { name: 'Cancel', exact: true });
    await tabTo(page, cancel, 'the cancel button of the delete dialog');
    await page.keyboard.press('Enter');
    await expect(confirmation).toHaveCount(0);
    await expect(deleteButton).toBeFocused();
    expect(deletes).toEqual([]);
    await expect(page).toHaveURL((url) => url.pathname === entityPath(entity));

    // The command search from the header button: Escape closes it and gives the focus back.
    const searchButton = page.getByRole('banner').getByRole('button', {
      name: 'Search',
      exact: true,
    });
    await tabTo(page, searchButton, 'the search button', { backward: true });
    await page.keyboard.press('Enter');
    const command = page.getByRole('dialog', { name: 'Search the catalog' });
    const input = command.getByRole('combobox', { name: 'Search blueprints and entities' });
    await expect(command).toBeVisible();
    await expect(input).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(command).toHaveCount(0);
    await expect(searchButton).toBeFocused();

    // The command search with Ctrl+K: a query, the arrow keys, and Enter on an entity.
    const { entity: found, query } = catalog.prefixSearch;
    await page.keyboard.press('Control+k');
    await expect(command).toBeVisible();
    await expect(input).toBeFocused();
    const answer = nextGet(page, '/v1/search/entities', { q: query });
    await page.keyboard.type(query);
    expect((await answer).status()).toBe(200);
    const firstEntity = command
      .getByRole('group', { name: 'Entities' })
      .getByRole('option')
      .first();
    await expect(firstEntity).toContainText(found.identifier);
    const blueprintOptions = await command
      .getByRole('group', { name: 'Blueprints' })
      .getByRole('option')
      .count();
    for (let step = 0; step < blueprintOptions; step += 1) await page.keyboard.press('ArrowDown');
    await expect(firstEntity).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL((url) => url.pathname === entityPath(found));
    await expect(command).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: found.title })).toBeVisible();
  });
});
