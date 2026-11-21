/**
 * 003 task 10.10 (design D5, D7, D12 to D14 and Resolved decisions Q84, Q85, Q89, Q90,
 * Q92): tenant isolation through the UI, against the stack of `scripts/ci/e2e.sh`,
 * through the shared fixture (every test also fails on a CSP violation, a console error,
 * an undeclared error answer or a request to another origin).
 *
 * Tenant A's member (no second factor, one sign-in per test) reaches for what only
 * tenant B has, from `fixtures/seed.ts`:
 *
 * - B's own blueprint (`ownBlueprint`), whose table URL must show the not-found page;
 * - B's entities: one in a blueprint identifier A also has (`sharedIdentifierEntity`,
 *   `service/svc-tenant-b-only`) and one in B's own blueprint, whose entity URLs must show
 *   the not-found page;
 * - B's `secret-svc` (`searchOnly`), which no search of A may show.
 *
 * Cross-tenant access looks exactly like "not found" (root `CLAUDE.md`, Q84): each page
 * is compared with the one for a path that exists in no tenant. Every `404` the flow
 * requires is declared (Q92), each one for its exact path, so any other error answer
 * still fails the test.
 */
import type { Page, Response } from '@playwright/test';

import { expect, test, type E2eSeed, type SeedEntity, type SeedUser } from './fixtures/test.js';

test.use({ locale: 'en-US' });

/** A blueprint and an entity identifier that no tenant of the seed has. */
const NOWHERE = 'no-such-thing-anywhere';

/** Signs a user without a second factor in from `/sign-in`, in English. */
async function signInWithoutMfa(page: Page, user: SeedUser): Promise<void> {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/');
}

/** The next answer to a `GET` of `path` whose query holds every pair of `query`. */
function nextGet(
  page: Page,
  path: string,
  query: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return page.waitForResponse((response) => {
    if (response.request().method() !== 'GET') return false;
    const url = new URL(response.url());
    if (url.pathname !== path) return false;
    return Object.entries(query).every(([key, value]) => url.searchParams.get(key) === value);
  });
}

/** Every blueprint and entity identifier of either tenant. */
function seededIdentifiers(seed: E2eSeed): Set<string> {
  const { a, b } = seed.tenants;
  return new Set([
    ...[...a.catalog.blueprints, ...b.catalog.blueprints].map((item) => item.identifier),
    ...[...a.catalog.entities, ...b.catalog.entities].map((item) => item.identifier),
  ]);
}

function entityApiPath(entity: Pick<SeedEntity, 'blueprint' | 'identifier'>): string {
  return `/v1/blueprints/${entity.blueprint}/entities/${entity.identifier}`;
}

/**
 * Opens `path`, waits for the `404` answer of `apiPath` and for the not-found page, and
 * returns the text of the main region: what the user sees of the page.
 */
async function notFoundPageAt(page: Page, path: string, apiPath: string): Promise<string> {
  const answer = nextGet(page, apiPath);
  await page.goto(path);
  expect((await answer).status()).toBe(404);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await expect(
    main.getByText('The page you are looking for does not exist or is not available.'),
  ).toBeVisible();
  await expect(main.getByRole('link', { name: 'Go to the home page' })).toBeVisible();
  await expect(main.getByRole('table')).toHaveCount(0);
  await expect(main.getByRole('status')).toHaveCount(0);
  await expect(main.getByRole('alert')).toHaveCount(0);
  return main.innerText();
}

test("Another tenant's blueprint is not found", async ({ page, seed, guard }) => {
  const a = seed.tenants.a;
  // GIVEN a user of tenant `t2` (A here), and a blueprint that exists only in tenant `t1`
  const theirs = seed.tenants.b.catalog.ownBlueprint;
  expect(a.catalog.blueprints.map((blueprint) => blueprint.identifier)).not.toContain(
    theirs.identifier,
  );
  expect(seededIdentifiers(seed).has(NOWHERE)).toBe(false);
  // Both table calls answer `404` for either blueprint (Q84).
  for (const identifier of [theirs.identifier, NOWHERE]) {
    guard.expectApiError(404, `/v1/blueprints/${identifier}`);
    guard.expectApiError(404, `/v1/blueprints/${identifier}/entities`);
  }

  await signInWithoutMfa(page, a.users.member);
  // The sidebar never lists it.
  const sidebar = page.getByRole('navigation', { name: 'Catalog' });
  await expect(
    sidebar.locator(`a[href="/catalog/${a.catalog.blueprints[0]?.identifier ?? ''}"]`),
  ).toBeVisible();
  await expect(sidebar.locator(`a[href="/catalog/${theirs.identifier}"]`)).toHaveCount(0);

  // WHEN they open the table URL of that blueprint
  // THEN the app shows the not-found page
  const theirsPage = await notFoundPageAt(
    page,
    `/catalog/${theirs.identifier}`,
    `/v1/blueprints/${theirs.identifier}`,
  );
  await expect(page.getByText(theirs.title, { exact: true })).toHaveCount(0);

  // The same page as for a blueprint that exists nowhere.
  const nowherePage = await notFoundPageAt(
    page,
    `/catalog/${NOWHERE}`,
    `/v1/blueprints/${NOWHERE}`,
  );
  expect(theirsPage).toBe(nowherePage);
});

test("Another tenant's entity URL shows the not-found page", async ({ page, seed, guard }) => {
  const a = seed.tenants.a;
  const b = seed.tenants.b.catalog;
  // B's entity in a blueprint identifier A also has, and B's entity in B's own blueprint.
  const shared = b.sharedIdentifierEntity;
  expect(a.catalog.blueprints.map((blueprint) => blueprint.identifier)).toContain(shared.blueprint);
  expect(a.catalog.entities.map((entity) => entity.identifier)).not.toContain(shared.identifier);
  const own = b.entities.find((entity) => entity.blueprint === b.ownBlueprint.identifier);
  if (own === undefined) throw new Error("The seed has no entity in tenant B's own blueprint.");
  const nowhere = { blueprint: shared.blueprint, identifier: NOWHERE };
  expect(seededIdentifiers(seed).has(NOWHERE)).toBe(false);
  // `entities.get` answers `404` for each; B's own blueprint is not found either (Q85).
  guard.expectApiError(404, entityApiPath(shared));
  guard.expectApiError(404, entityApiPath(own));
  guard.expectApiError(404, `/v1/blueprints/${own.blueprint}`);
  guard.expectApiError(404, entityApiPath(nowhere));

  await signInWithoutMfa(page, a.users.member);

  // WHEN a user of tenant A opens the entity URL of tenant B's entity
  // THEN the app shows the not-found page
  const sharedPage = await notFoundPageAt(
    page,
    `/catalog/${shared.blueprint}/${shared.identifier}`,
    entityApiPath(shared),
  );
  await expect(page.getByText(shared.title, { exact: true })).toHaveCount(0);
  const ownPage = await notFoundPageAt(
    page,
    `/catalog/${own.blueprint}/${own.identifier}`,
    entityApiPath(own),
  );
  await expect(page.getByText(own.title, { exact: true })).toHaveCount(0);

  // The same page as for an entity that exists nowhere.
  const nowherePage = await notFoundPageAt(
    page,
    `/catalog/${nowhere.blueprint}/${nowhere.identifier}`,
    entityApiPath(nowhere),
  );
  expect(sharedPage).toBe(nowherePage);
  expect(ownPage).toBe(nowherePage);
});

test("Search never shows another tenant's entity", async ({ page, seed }) => {
  // GIVEN an entity `secret-svc` in tenant `t1` (B here) only
  const { entity: secret, query } = seed.tenants.b.catalog.searchOnly;
  expect(secret.identifier.startsWith(query)).toBe(true);
  expect(seed.tenants.a.catalog.entities.map((entity) => entity.identifier)).not.toContain(
    secret.identifier,
  );

  // WHEN a user of tenant `t2` (A here) searches for `secret`, from the command dialog
  await signInWithoutMfa(page, seed.tenants.a.users.member);
  await expect(page.getByRole('navigation', { name: 'Catalog' })).toBeVisible();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Search the catalog' });
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('combobox', { name: 'Search blueprints and entities' });
  await expect(input).toBeFocused();
  const commandAnswer = nextGet(page, '/v1/search/entities', { q: query });
  await page.keyboard.type(query);
  const commandResponse = await commandAnswer;
  expect(commandResponse.status()).toBe(200);
  expect(await commandResponse.json()).toEqual({ items: [] });

  // THEN no result is shown: the only option is "See all results"
  const seeAll = dialog.getByRole('option', { name: 'See all results' });
  await expect(seeAll).toBeVisible();
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await expect(dialog.getByRole('group', { name: 'Entities' })).toHaveCount(0);
  await expect(dialog.getByText(secret.identifier)).toHaveCount(0);
  await expect(dialog.getByText(secret.title)).toHaveCount(0);

  // And on the search page, for the same query: up to 50 results, none of them B's.
  const pageAnswer = nextGet(page, '/v1/search/entities', { q: query, limit: '50' });
  await expect(seeAll).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(
    (url) => url.pathname === '/search' && url.searchParams.get('q') === query,
  );
  const pageResponse = await pageAnswer;
  expect(pageResponse.status()).toBe(200);
  expect(await pageResponse.json()).toEqual({ items: [] });
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Search results' })).toBeVisible();
  await expect(main.getByText('No results.', { exact: true })).toBeVisible();
  await expect(main.getByRole('link', { name: secret.identifier })).toHaveCount(0);
  await expect(main.getByText(secret.title)).toHaveCount(0);

  // An exact identifier of B, in a blueprint identifier A also has, finds nothing either.
  const shared = seed.tenants.b.catalog.sharedIdentifierEntity;
  const exactAnswer = nextGet(page, '/v1/search/entities', { q: shared.identifier });
  await page.goto(`/search?q=${shared.identifier}`);
  const exactResponse = await exactAnswer;
  expect(exactResponse.status()).toBe(200);
  expect(await exactResponse.json()).toEqual({ items: [] });
  await expect(main.getByText('No results.', { exact: true })).toBeVisible();
  await expect(main.getByRole('link', { name: shared.identifier })).toHaveCount(0);
});
