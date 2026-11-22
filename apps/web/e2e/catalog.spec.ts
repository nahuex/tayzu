/**
 * 003 task 10.7 (design D5, D6, D12 to D14 and Resolved decisions Q83, Q86, Q87, Q90):
 * the catalog end to end, against the stack of `scripts/ci/e2e.sh`, through the shared
 * fixture (every test also fails on a CSP violation, a console error, an undeclared
 * error answer or a request to another origin).
 *
 * Every test signs tenant A's member in (no second factor, one sign-in each) and reads
 * the seeded catalog of `fixtures/seed.ts`:
 *
 * - "Sort by title and page forward": the 120 entities of `catalog.paging.blueprint`,
 *   whose titles (`Component 000` to `Component 119`, a fixed prefix and three digits)
 *   are in another order than their identifiers. Such titles order the same under any
 *   collation, so the expected sequence is computed here from the seed's own titles.
 * - "Related entities in both directions": `catalog.relation`, `payments-api` depends
 *   on `svc-ledger`.
 * - "Status shown next to spec": `catalog.status`, `svc-checkout` with a status the seed
 *   wrote as an integration would.
 * - "Search by identifier prefix from the keyboard": `catalog.prefixSearch`, the only
 *   identifier of tenant A that starts with `paym`.
 *
 * The command dialog searches 250 ms after the last keystroke (Q90): the tests wait for
 * the answer to the typed query, never for a fixed time.
 */
import type { Locator, Page, Response } from '@playwright/test';

import { expect, test, type SeedEntity, type SeedUser } from './fixtures/test.js';

test.use({ locale: 'en-US' });

/** The table's default page size (Q67, Q68), which every `entities.list` call sends (Q83). */
const DEFAULT_PAGE_SIZE = 50;

/** Signs a user without a second factor in from `/sign-in`, in English. */
async function signInWithoutMfa(page: Page, user: SeedUser): Promise<void> {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/');
}

/**
 * The next answer to a `GET` of `path` whose query holds every pair of `query`, and
 * holds no key of `absent`. Created before the action that sends the request.
 */
function nextGet(
  page: Page,
  path: string,
  query: Readonly<Record<string, string>> = {},
  absent: readonly string[] = [],
): Promise<Response> {
  return page.waitForResponse((response) => {
    if (response.request().method() !== 'GET') return false;
    const url = new URL(response.url());
    if (url.pathname !== path) return false;
    if (absent.some((key) => url.searchParams.has(key))) return false;
    return Object.entries(query).every(([key, value]) => url.searchParams.get(key) === value);
  });
}

function entityPath(entity: SeedEntity): string {
  return `/catalog/${entity.blueprint}/${entity.identifier}`;
}

function entityApiPath(entity: SeedEntity): string {
  return `/v1/blueprints/${entity.blueprint}/entities/${entity.identifier}`;
}

function exactText(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/** The `<dd>` of the `<dt>` whose whole text is `label`, inside `scope`. */
function fieldValue(scope: Locator, label: string): Locator {
  return scope
    .locator('dt')
    .filter({ hasText: exactText(label) })
    .locator('xpath=following-sibling::dd[1]');
}

/** The rows of the Related tab's table whose identifier link is `identifier`. */
function relatedRow(page: Page, identifier: string): Locator {
  return page
    .getByRole('table', { name: 'Related entities' })
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: identifier, exact: true }) });
}

test('Sort by title and page forward', async ({ page, seed }) => {
  const catalog = seed.tenants.a.catalog;
  const blueprint = catalog.blueprints.find(
    (candidate) => candidate.identifier === catalog.paging.blueprint,
  );
  if (blueprint === undefined) throw new Error('The seed has no paging blueprint.');
  const seeded = catalog.entities.filter((entity) => entity.blueprint === blueprint.identifier);

  // GIVEN a blueprint with 120 readable entities
  expect(seeded).toHaveLength(catalog.paging.entityCount);
  expect(catalog.paging.entityCount).toBeGreaterThanOrEqual(120);
  // Titles that order the same under any collation: one prefix, then fixed-width digits.
  for (const entity of seeded) expect(entity.title).toMatch(/^Component \d{3}$/);
  expect(new Set(seeded.map((entity) => entity.title)).size).toBe(seeded.length);
  // Title descending, as the server sorts it (`title desc, identifier desc`).
  const expected = [...seeded].sort((left, right) =>
    left.title < right.title ? 1 : left.title > right.title ? -1 : 0,
  );
  const byIdentifier = [...seeded].sort((left, right) =>
    left.identifier < right.identifier ? 1 : left.identifier > right.identifier ? -1 : 0,
  );
  // Sorting by title is visibly not sorting by identifier.
  expect(expected.slice(0, DEFAULT_PAGE_SIZE).map((entity) => entity.identifier)).not.toEqual(
    byIdentifier.slice(0, DEFAULT_PAGE_SIZE).map((entity) => entity.identifier),
  );
  const firstPage = expected.slice(0, DEFAULT_PAGE_SIZE);
  const secondPage = expected.slice(DEFAULT_PAGE_SIZE, 2 * DEFAULT_PAGE_SIZE);

  await signInWithoutMfa(page, seed.tenants.a.users.member);
  const listPath = `/v1/blueprints/${blueprint.identifier}/entities`;
  const firstLoad = nextGet(page, listPath);
  await page.goto(`/catalog/${blueprint.identifier}`);
  expect((await firstLoad).status()).toBe(200);
  const table = page.getByRole('table', { name: blueprint.title });
  await expect(page.getByRole('heading', { level: 1, name: blueprint.title })).toBeVisible();
  const identifiers = table.locator('tbody tr td:nth-child(1)');
  const titles = table.locator('tbody tr td:nth-child(2)');
  await expect(identifiers).toHaveCount(DEFAULT_PAGE_SIZE);

  // WHEN the user sorts by title descending: a new column starts ascending, a second
  // click on it toggles the order
  const titleHeader = table.getByRole('columnheader', { name: 'Title' });
  const titleSort = titleHeader.getByRole('button', { name: 'Title', exact: true });
  const ascending = nextGet(
    page,
    listPath,
    { sort: 'title', order: 'asc', pageSize: String(DEFAULT_PAGE_SIZE) },
    ['cursor'],
  );
  await titleSort.click();
  expect((await ascending).status()).toBe(200);
  await expect(titleHeader).toHaveAttribute('aria-sort', 'ascending');
  const descending = nextGet(
    page,
    listPath,
    { sort: 'title', order: 'desc', pageSize: String(DEFAULT_PAGE_SIZE) },
    ['cursor'],
  );
  await titleSort.click();
  expect((await descending).status()).toBe(200);
  await expect(titleHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(titles).toHaveText(firstPage.map((entity) => entity.title));
  await expect(identifiers).toHaveText(firstPage.map((entity) => entity.identifier));
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();

  // AND moves to the next page
  const next = nextGet(page, listPath, {
    sort: 'title',
    order: 'desc',
    pageSize: String(DEFAULT_PAGE_SIZE),
  });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const nextAnswer = await next;
  expect(nextAnswer.status()).toBe(200);
  expect(new URL(nextAnswer.url()).searchParams.has('cursor')).toBe(true);

  // THEN the second page continues the descending order with no gap and no repeat
  await expect(titleHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(titles).toHaveText(secondPage.map((entity) => entity.title));
  await expect(identifiers).toHaveText(secondPage.map((entity) => entity.identifier));
  const shown = [...firstPage, ...secondPage].map((entity) => entity.identifier);
  expect(new Set(shown).size).toBe(2 * DEFAULT_PAGE_SIZE);
  expect(shown).toEqual(expected.slice(0, 2 * DEFAULT_PAGE_SIZE).map((e) => e.identifier));
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeEnabled();
});

test('Related entities in both directions', async ({ page, seed }) => {
  // GIVEN `payments` depends on `ledger`
  const { from: payments, to: ledger, relation } = seed.tenants.a.catalog.relation;
  expect(relation).toBe('dependsOn');

  await signInWithoutMfa(page, seed.tenants.a.users.member);
  await page.goto(entityPath(ledger));
  await expect(page.getByRole('heading', { level: 1, name: ledger.title })).toBeVisible();

  // WHEN the user opens `ledger`'s Related tab: forward by default, where `payments`,
  // which points at `ledger`, is not listed
  const relatedPath = `${entityApiPath(ledger)}/related`;
  const forward = nextGet(page, relatedPath, { direction: 'forward' });
  await page.getByRole('tab', { name: 'Related', exact: true }).click();
  expect((await forward).status()).toBe(200);
  await expect(page.getByRole('radio', { name: 'Forward', exact: true })).toBeChecked();
  const relatedTable = page.getByRole('table', { name: 'Related entities' });
  await expect(relatedTable.getByRole('status')).toHaveCount(0);
  await expect(relatedRow(page, payments.identifier)).toHaveCount(0);

  // AND chooses backward
  const backward = nextGet(page, relatedPath, { direction: 'backward' });
  await page.getByRole('radio', { name: 'Backward', exact: true }).check();
  expect((await backward).status()).toBe(200);

  // THEN `payments` is listed
  const row = relatedRow(page, payments.identifier);
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('cell')).toHaveText([
    relation,
    payments.identifier,
    payments.title,
    payments.blueprint,
    'Spec',
  ]);

  // AND links to its entity page
  await row.getByRole('link', { name: payments.identifier, exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === entityPath(payments));
  await expect(page.getByRole('heading', { level: 1, name: payments.title })).toBeVisible();

  // The other direction: `payments`' forward relations list `ledger`, linked to its page.
  const paymentsForward = nextGet(page, `${entityApiPath(payments)}/related`, {
    direction: 'forward',
  });
  await page.getByRole('tab', { name: 'Related', exact: true }).click();
  expect((await paymentsForward).status()).toBe(200);
  await expect(page.getByRole('radio', { name: 'Forward', exact: true })).toBeChecked();
  const back = relatedRow(page, ledger.identifier);
  await expect(back).toHaveCount(1);
  await expect(back.getByRole('cell')).toHaveText([
    relation,
    ledger.identifier,
    ledger.title,
    ledger.blueprint,
    'Spec',
  ]);
  await back.getByRole('link', { name: ledger.identifier, exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === entityPath(ledger));
  await expect(page.getByRole('heading', { level: 1, name: ledger.title })).toBeVisible();
});

test('Status shown next to spec', async ({ page, seed }) => {
  // GIVEN an entity with status written by an integration
  const status = seed.tenants.a.catalog.status;

  await signInWithoutMfa(page, seed.tenants.a.users.member);
  const loaded = nextGet(page, entityApiPath(status.entity));
  await page.goto(entityPath(status.entity));
  expect((await loaded).status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: status.entity.title })).toBeVisible();

  // WHEN the user opens its Details tab (the default one)
  const details = page.getByRole('tab', { name: 'Details', exact: true });
  await details.click();
  await expect(details).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('tabpanel', { name: 'Details' });

  // THEN the status properties are shown
  const statusRegion = panel.getByRole('region', { name: 'Status', exact: true });
  await expect(statusRegion).toBeVisible();
  await expect(fieldValue(statusRegion, status.propertyTitle)).toHaveText(status.value);
  // AND with their observed generation and source
  await expect(fieldValue(statusRegion, 'Observed generation')).toHaveText(
    String(status.observedGeneration),
  );
  await expect(fieldValue(statusRegion, 'Source')).toHaveText(status.source);
  await expect(fieldValue(statusRegion, 'Observed')).toHaveText(/\S/);
  await expect(statusRegion.getByText('No status has been reported for this entity.')).toHaveCount(
    0,
  );

  // Next to the spec, in the same panel, and not paired with it.
  const specRegion = panel.getByRole('region', { name: 'Spec', exact: true });
  await expect(specRegion).toBeVisible();
  await expect(fieldValue(specRegion, status.specProperty.title)).toHaveText(
    status.specProperty.value,
  );
  await expect(
    specRegion.locator('dt').filter({ hasText: exactText(status.propertyTitle) }),
  ).toHaveCount(0);
  await expect(
    statusRegion.locator('dt').filter({ hasText: exactText(status.specProperty.title) }),
  ).toHaveCount(0);
});

test('Search by identifier prefix from the keyboard', async ({ page, seed }) => {
  // GIVEN a signed-in user and an entity `payments-api`
  const { entity, query } = seed.tenants.a.catalog.prefixSearch;
  expect(entity.identifier.startsWith(query)).toBe(true);
  await signInWithoutMfa(page, seed.tenants.a.users.member);
  await expect(page.getByRole('navigation', { name: 'Catalog' })).toBeVisible();

  // WHEN they press Ctrl+K
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Search the catalog' });
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('combobox', { name: 'Search blueprints and entities' });
  await expect(input).toBeFocused();

  // AND type `paym`: the answer to the whole query, after the debounce
  const answer = nextGet(page, '/v1/search/entities', { q: query });
  await page.keyboard.type(query);
  expect((await answer).status()).toBe(200);
  await expect(input).toHaveValue(query);

  // The first entity result is `payments-api`.
  const entities = dialog.getByRole('group', { name: 'Entities' });
  const firstEntity = entities.getByRole('option').first();
  await expect(firstEntity).toContainText(entity.identifier);
  await expect(firstEntity).toContainText(entity.title);

  // AND press Enter on the first entity result, reached with the keyboard only
  const blueprintOptions = await dialog
    .getByRole('group', { name: 'Blueprints' })
    .getByRole('option')
    .count();
  for (let step = 0; step < blueprintOptions; step += 1) await page.keyboard.press('ArrowDown');
  await expect(firstEntity).toHaveAttribute('aria-selected', 'true');
  await expect(input).toBeFocused();
  await page.keyboard.press('Enter');

  // THEN the entity page of `payments-api` opens
  await expect(page).toHaveURL((url) => url.pathname === entityPath(entity));
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: entity.title })).toBeVisible();
  await expect(fieldValue(page.getByRole('main'), 'Identifier')).toHaveText(entity.identifier);
});
