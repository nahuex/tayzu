/**
 * 003 task 10.3 (design D11, D16 and Resolved decisions Q72, Q75, Q76, Q88): Visma
 * Connect end to end, through the OIDC stub of `@tayzu/auth` behind the stack's TLS
 * proxy. The shared fixture lets requests reach the stub's origin (`allowOidcOrigin`),
 * and still fails a test on a CSP violation, a console error or any other origin.
 *
 * - "Visma Connect sign-in": the click posts the social sign-in, the browser leaves for
 *   the stub, whose `form_post` page posts the callback to the app's origin, and the
 *   user lands signed in on the home page.
 * - "A Visma Connect user re-authorizes": the user deletes the entity they created, the
 *   step-up dialog offers only "Continue with Visma Connect", the stub's round trip
 *   comes back through the re-authorization callback, which answers `303` to the fixed
 *   `/step-up/complete`, the app returns to the entity page with the "repeat the action"
 *   notice (the action is not repeated for the user), and repeating the delete succeeds.
 *
 * Recorded URLs keep their origin and path only: a callback's code and state never
 * reach an assertion message or a report.
 */
import type { Page, Request } from '@playwright/test';

import { apiGet } from './fixtures/browser-api.js';
import { expect, test, type E2eSeed, type SeedEntity } from './fixtures/test.js';

test.use({ allowOidcOrigin: true, locale: 'en-US' });

/** Better Auth's generic OAuth callback of the `visma-connect` provider. */
const SIGN_IN_CALLBACK_PATH = '/api/auth/callback/visma-connect';
/** The API's re-authorization callback (003 D11, 002 Q36). */
const REAUTH_CALLBACK_PATH = '/v1/auth/visma-connect/reauthorize/callback';

/** The requests of a page whose URL has `path` on `origin`, as they are made. */
function recordRequests(page: Page, origin: string, path: string): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname === path) seen.push(request);
  });
  return seen;
}

/** Signs the seeded Visma Connect user in from `/sign-in`, through the stub. */
async function signInWithVismaConnect(page: Page, seed: E2eSeed): Promise<Request[]> {
  const callbacks = recordRequests(page, seed.appOrigin, SIGN_IN_CALLBACK_PATH);
  const authorizations = recordRequests(page, seed.oidcOrigin, '/authorize');

  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
  // Nothing has left the app before the click.
  expect(authorizations).toEqual([]);

  await page.getByRole('button', { name: 'Sign in with Visma Connect' }).click();
  await expect(page).toHaveURL((url) => url.origin === seed.appOrigin && url.pathname === '/', {
    timeout: 20_000,
  });

  // The browser went through the stub's authorization endpoint once.
  expect(authorizations).toHaveLength(1);
  return callbacks;
}

function sidebar(page: Page) {
  return page.getByRole('navigation', { name: 'Catalog' });
}

/** The entity's `entities.get` route. */
function entityApiPath(entity: SeedEntity): string {
  return `/v1/blueprints/${entity.blueprint}/entities/${entity.identifier}`;
}

function entityPath(entity: SeedEntity): string {
  return `/catalog/${entity.blueprint}/${entity.identifier}`;
}

test('Visma Connect sign-in', async ({ page, seed }) => {
  const user = seed.tenants.a.users.vismaConnect;

  // GIVEN a user linked to Visma Connect
  // WHEN they choose "Sign in with Visma Connect" and complete the provider's flow
  const callbacks = await signInWithVismaConnect(page, seed);

  // The provider's `form_post` page posted the callback to the app's origin, from the
  // provider's document.
  const posted = callbacks.filter((request) => request.method() === 'POST');
  expect(posted).toHaveLength(1);
  const [formPost] = posted;
  expect(formPost?.isNavigationRequest()).toBe(true);
  expect(await formPost?.headerValue('content-type')).toMatch(
    /^application\/x-www-form-urlencoded/,
  );
  expect(await formPost?.headerValue('origin')).toBe(seed.oidcOrigin);

  // THEN they return signed in to the home page
  await expect(page).toHaveURL((url) => url.pathname === '/');
  await expect(sidebar(page)).toBeVisible();
  for (const blueprint of seed.tenants.a.catalog.blueprints) {
    // By path: the system `_team` blueprint is titled "Team" too.
    const link = sidebar(page).locator(`a[href="/catalog/${blueprint.identifier}"]`);
    await expect(link).toHaveAccessibleName(blueprint.title);
  }
  await page.getByRole('button', { name: 'User menu' }).click();
  await expect(page.getByRole('menu').getByText(user.name, { exact: true })).toBeVisible();
  await expect(
    page.getByRole('menu').getByText(seed.tenants.a.name, { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const me = await apiGet(page, '/v1/me');
  expect(me.status).toBe(200);
  expect(me.body).toEqual(
    expect.objectContaining({
      user: expect.objectContaining({ email: user.email }),
      signInMethod: 'visma-connect',
      gate: 'none',
    }),
  );
});

test('A Visma Connect user re-authorizes', async ({ page, seed, guard }) => {
  test.setTimeout(60_000);
  const entity = seed.tenants.a.catalog.vismaConnectDeletable;
  const path = entityPath(entity);

  // GIVEN a user signed in through Visma Connect
  await signInWithVismaConnect(page, seed);

  // WHEN they delete an entity
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: entity.title })).toBeVisible();
  await page.getByRole('button', { name: 'Delete entity' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete this entity?' });
  await expect(confirmation).toBeVisible();
  // The first delete is answered `403 AUTH_STEP_UP_REQUIRED` (Q92).
  guard.expectApiError(403, entityApiPath(entity));
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();

  // The step-up prompt of a Visma Connect session: the round trip, and no local field.
  const stepUp = page.getByRole('dialog', { name: 'Verify your identity' });
  await expect(stepUp).toBeVisible();
  const continueButton = stepUp.getByRole('button', { name: 'Continue with Visma Connect' });
  await expect(continueButton).toBeVisible();
  await expect(stepUp.getByRole('textbox')).toHaveCount(0);
  await expect(stepUp.locator('input[type="password"]')).toHaveCount(0);
  // The entity is still there: the refused delete changed nothing.
  expect((await apiGet(page, entityApiPath(entity))).status).toBe(200);

  // AND choose "Continue with Visma Connect" and complete the provider's step-up
  const callbacks = recordRequests(page, seed.appOrigin, REAUTH_CALLBACK_PATH);
  const completions = recordRequests(page, seed.appOrigin, '/step-up/complete');
  await continueButton.click();

  // THEN they return to the entity page with a notice to repeat the action
  await expect(page).toHaveURL((url) => url.origin === seed.appOrigin && url.pathname === path, {
    timeout: 20_000,
  });
  await expect(
    page.getByRole('status').filter({ hasText: 'You are back. Repeat the action to continue.' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: entity.title })).toBeVisible();

  // The callback answered `303` to the fixed `/step-up/complete`, with no `result`.
  expect(callbacks).toHaveLength(1);
  const [callback] = callbacks;
  const answer = await callback?.response();
  expect(answer?.status()).toBe(303);
  expect(answer?.headers()['location']).toBe('/step-up/complete');
  expect(completions).toHaveLength(1);
  expect(completions[0]?.redirectedFrom()).toBe(callback);
  expect(new URL(completions[0]?.url() ?? seed.appOrigin).search).toBe('');

  // The action was not repeated for the user: the entity still exists.
  expect((await apiGet(page, entityApiPath(entity))).status).toBe(200);

  // AND repeating it succeeds
  await page.getByRole('button', { name: 'Delete entity' }).click();
  const again = page.getByRole('dialog', { name: 'Delete this entity?' });
  await again.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === `/catalog/${entity.blueprint}`);
  await expect(page.getByRole('dialog', { name: 'Verify your identity' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: entity.title, exact: true })).toHaveCount(0);
  // Gone: `entities.get` answers `404` (Q92).
  guard.expectApiError(404, entityApiPath(entity));
  expect((await apiGet(page, entityApiPath(entity))).status).toBe(404);
});
