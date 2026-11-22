/**
 * The tour of every page and every dialog of the app (003 tasks 10.8 and 10.9, design
 * D10 and D16), shared by `csp.spec.ts` and `a11y.spec.ts`, so that both specs check
 * exactly the same stops. At each stop the page or dialog is shown, and the tour calls
 * the spec's `Checkpoint` with a label that names the stop (never a value): the CSP spec
 * lets the page settle there, the accessibility spec runs axe there.
 *
 * - `tourPublicPages`: sign-in (its form, a refused sign-in, the second-factor step),
 *   forgot password (its form and its message), reset and accept with an invalid link,
 *   step-up complete with each `result` (`failed`, `rate_limited`, none), and an unknown
 *   path. Two local sign-ins.
 * - `tourGatePages`: the change-password page (`temporaryPassword`, still under its
 *   temporary password) and the MFA enrolment page (`adminWithoutMfa`, never enrolled).
 *   Two local sign-ins. The expired-password page is not seedable: the temporary
 *   password lives 48 hours (`TEMPORARY_PASSWORD_TTL_MS` of `@tayzu/auth`) and the seed
 *   works through the services only, never through SQL.
 * - `tourSignedInPages`: home, the user menu, the locale and theme menus, the command
 *   search (empty and with results), a table (default and sorted), an entity's details
 *   and related tabs, the search page (prompt and results), the not-found pages, the
 *   delete confirmation and the local step-up dialog (password), both cancelled. One
 *   local sign-in, of `dialogOwner`.
 * - `tourVismaConnectStepUp`: the step-up dialog of a Visma Connect session, cancelled.
 *   No local sign-in; the test must set `allowOidcOrigin`.
 *
 * The step-up dialog of a local session with TOTP is not on the tour: a TOTP sign-in is a
 * fresh verification for five minutes, so reaching that prompt costs a five-minute wait
 * (as `step-up.spec.ts` does) or deletes the entity.
 *
 * Every user and entity here is read-only for the tour: nothing is changed, every
 * delete is cancelled, and no single-use seed item of another spec is used (Q93). Every
 * error answer the tour requires is declared on the guard before its action (Q92).
 */
import { randomBytes } from 'node:crypto';

import type { BrowserContext, Page, Response } from '@playwright/test';

import { apiGet } from './browser-api.js';
import { SIGN_IN_PATH } from './sign-in-pace.js';
import { expect, type E2eSeed, type PageGuard, type SeedEntity, type SeedUser } from './test.js';

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** The local sign-ins each tour makes, for the tests' `signInBudget` (Q93). */
export const SIGN_IN_BUDGET = {
  publicPages: 2,
  gatePages: 2,
  signedInPages: 1,
  vismaConnect: 0,
} as const;

/** One stop of the tour: what is on screen is ready; `label` names the stop, never a value. */
export type Checkpoint = (label: string) => Promise<void>;

/** A blueprint, an entity and a path that no tenant of the seed has. */
export const NOWHERE = 'no-such-thing-anywhere';

/** The `dark` class on `<html>` is the theme (D12): present exactly in the dark theme. */
export async function expectTheme(page: Page, theme: Theme): Promise<void> {
  const html = page.locator('html');
  if (theme === 'dark') await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  else await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
}

/** The next answer to a `GET` of `path` whose query holds every pair of `query`. */
export function nextGet(
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

export function entityPath(entity: Pick<SeedEntity, 'blueprint' | 'identifier'>): string {
  return `/catalog/${entity.blueprint}/${entity.identifier}`;
}

export function entityApiPath(entity: Pick<SeedEntity, 'blueprint' | 'identifier'>): string {
  return `/v1/blueprints/${entity.blueprint}/entities/${entity.identifier}`;
}

/** Fills the sign-in form with email and password and submits it; no URL is expected. */
export async function submitSignIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Signs a user without a second factor in, and waits for the home page. */
export async function signInWithoutMfa(page: Page, user: SeedUser): Promise<void> {
  await submitSignIn(page, user.email, user.password);
  await expect(page).toHaveURL((url) => url.pathname === '/');
  await expect(page.getByRole('navigation', { name: 'Catalog' })).toBeVisible();
}

/** Signs the seeded Visma Connect user in through the OIDC stub (`allowOidcOrigin`). */
export async function signInWithVismaConnect(page: Page, seed: E2eSeed): Promise<void> {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with Visma Connect' }).click();
  await expect(page).toHaveURL((url) => url.origin === seed.appOrigin && url.pathname === '/', {
    timeout: 20_000,
  });
  await expect(page.getByRole('navigation', { name: 'Catalog' })).toBeVisible();
}

/** An address no account has, and a password no account uses: random per call. */
function unknownCredentials(): { readonly email: string; readonly password: string } {
  const tag = randomBytes(6).toString('hex');
  return { email: `e2e-nobody-${tag}@example.test`, password: `Nobody-${tag}-Pw1!` };
}

/**
 * Every public page, signed out. Two local sign-ins: a refused one and the admin's
 * password step, which stops at the second factor (no code is spent).
 */
export async function tourPublicPages(
  page: Page,
  seed: E2eSeed,
  guard: PageGuard,
  check: Checkpoint,
): Promise<void> {
  // Signed out, the gate's `401` sends `/` to sign-in; a refused sign-in is a `401` (Q92).
  guard.expectApiError(401, '/v1/me');
  guard.expectApiError(401, SIGN_IN_PATH);

  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Visma Connect' })).toBeVisible();
  await check('sign-in');

  const nobody = unknownCredentials();
  await submitSignIn(page, nobody.email, nobody.password);
  await expect(
    page.getByRole('alert').filter({ hasText: 'The email or password is incorrect.' }),
  ).toBeVisible();
  await check('sign-in, refused credentials');

  await page.goto('/forgot-password');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Forgot your password?' }),
  ).toBeVisible();
  await check('forgot password');
  await page.getByLabel('Email').fill(unknownCredentials().email);
  await page.getByRole('button', { name: 'Send reset link', exact: true }).click();
  await expect(
    page.getByText(
      'If an account exists for this email, a link to reset the password has been sent.',
    ),
  ).toBeVisible();
  await check('forgot password, sent');

  // No fragment: the invalid-link alert, with no form and no request.
  await page.goto('/reset-password');
  await expect(page.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: 'This link is invalid or has expired.' }),
  ).toBeVisible();
  await check('reset password, invalid link');

  await page.goto('/accept-invitation');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Accept your invitation' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
  await check('accept invitation, invalid link');

  await page.goto('/step-up/complete?result=failed');
  await expect(page.getByRole('heading', { level: 1, name: 'Verify your identity' })).toBeVisible();
  await expect(
    page.getByRole('alert').filter({
      hasText: 'Visma Connect could not confirm your identity. Repeat the action to try again.',
    }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go back' })).toBeVisible();
  await check('step-up complete, failed');

  await page.goto('/step-up/complete?result=rate_limited');
  await expect(page.getByRole('heading', { level: 1, name: 'Verify your identity' })).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Too many attempts. Try again in a few minutes.' }),
  ).toBeVisible();
  await check('step-up complete, rate limited');

  // No result: the page replaces itself with `/`, which a signed-out visitor meets as sign-in.
  await page.goto('/step-up/complete');
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
  await check('step-up complete, no result');

  await page.goto(`/${NOWHERE}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to the home page' })).toBeVisible();
  await check('not found, signed out');

  // The admin's password, then the second-factor step; no code is entered.
  const admin = seed.tenants.a.users.admin;
  await submitSignIn(page, admin.email, admin.password);
  await expect(page.getByLabel('Authentication code')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify', exact: true })).toBeVisible();
  await check('sign-in, second factor');
}

/**
 * The gate pages: change-password and MFA enrolment, each reached by a sign-in of the
 * seed user that is still gated. Neither user is changed.
 */
export async function tourGatePages(
  page: Page,
  context: BrowserContext,
  seed: E2eSeed,
  check: Checkpoint,
): Promise<void> {
  const { temporaryPassword, adminWithoutMfa } = seed.tenants.a.users;

  await submitSignIn(page, temporaryPassword.email, temporaryPassword.password);
  await expect(page).toHaveURL((url) => url.pathname === '/change-password');
  await expect(page.getByRole('heading', { level: 1, name: 'Change your password' })).toBeVisible();
  await expect(page.getByLabel('Current password')).toBeVisible();
  await check('change password');

  await context.clearCookies();
  await submitSignIn(page, adminWithoutMfa.email, adminWithoutMfa.password);
  await expect(page).toHaveURL((url) => url.pathname === '/mfa/enrol');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Set up two-factor authentication' }),
  ).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await check('MFA enrolment');
}

/** Opens a header menu by its button's name, checks it, and closes it with `Escape`. */
async function checkHeaderMenu(
  page: Page,
  button: string,
  item: { readonly role: 'menuitem' | 'menuitemradio'; readonly name: string },
  label: string,
  check: Checkpoint,
): Promise<void> {
  const trigger = page.getByRole('banner').getByRole('button', { name: button, exact: true });
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole(item.role, { name: item.name })).toBeVisible();
  await check(label);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

/**
 * Opens the delete confirmation of `entity`, then confirms: the first delete is answered
 * `403 AUTH_STEP_UP_REQUIRED` (declared by the caller, Q92), and the step-up dialog
 * opens. Returns both dialogs.
 */
async function openStepUpOverDelete(page: Page, entity: SeedEntity) {
  await page.goto(entityPath(entity));
  await expect(page.getByRole('heading', { level: 1, name: entity.title })).toBeVisible();
  await page.getByRole('button', { name: 'Delete entity' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete this entity?' });
  await expect(confirmation).toBeVisible();
  return {
    confirmation,
    async confirm() {
      await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
      const stepUp = page.getByRole('dialog', { name: 'Verify your identity' });
      await expect(stepUp).toBeVisible();
      return stepUp;
    },
  };
}

/** Cancels the step-up dialog, then the delete confirmation; the entity is still there. */
async function cancelStepUpAndDelete(
  page: Page,
  entity: SeedEntity,
  confirmation: ReturnType<Page['getByRole']>,
  stepUp: ReturnType<Page['getByRole']>,
): Promise<void> {
  await stepUp.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(stepUp).toHaveCount(0);
  // A cancelled step-up shows nothing in the confirmation, which stays open.
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect((await apiGet(page, entityApiPath(entity))).status).toBe(200);
}

/**
 * Every signed-in page and every dialog of the shell, as `dialogOwner` (one sign-in).
 * The delete of the owner's entity is cancelled at the step-up prompt.
 */
export async function tourSignedInPages(
  page: Page,
  seed: E2eSeed,
  guard: PageGuard,
  check: Checkpoint,
): Promise<void> {
  const tenant = seed.tenants.a;
  const catalog = tenant.catalog;
  const owned = catalog.dialogEntities.local;
  const missingEntity = { blueprint: catalog.status.entity.blueprint, identifier: NOWHERE };
  // The not-found pages (Q84, Q85) and the step-up refusal of the owner's delete (Q92).
  guard.expectApiError(404, entityApiPath(missingEntity));
  guard.expectApiError(404, `/v1/blueprints/${NOWHERE}`);
  guard.expectApiError(404, `/v1/blueprints/${NOWHERE}/entities`);
  guard.expectApiError(404, `/v1/blueprints/${NOWHERE}/entities/${NOWHERE}`);
  guard.expectApiError(403, entityApiPath(owned));

  await signInWithoutMfa(page, tenant.users.dialogOwner);
  const main = page.getByRole('main');
  await expect(page.getByRole('banner')).toBeVisible();
  await check('home');

  // The header's menus.
  await checkHeaderMenu(
    page,
    'User menu',
    { role: 'menuitem', name: 'Sign out' },
    'user menu',
    check,
  );
  await checkHeaderMenu(
    page,
    'Language',
    { role: 'menuitemradio', name: 'English' },
    'locale menu',
    check,
  );
  await checkHeaderMenu(
    page,
    'Theme',
    { role: 'menuitemradio', name: 'Dark' },
    'theme menu',
    check,
  );

  // The command search, empty, then with results.
  await page.keyboard.press('Control+k');
  const command = page.getByRole('dialog', { name: 'Search the catalog' });
  await expect(command).toBeVisible();
  const input = command.getByRole('combobox', { name: 'Search blueprints and entities' });
  await expect(input).toBeFocused();
  await check('command search, empty');
  const { query, entity: found } = catalog.prefixSearch;
  const answer = nextGet(page, '/v1/search/entities', { q: query });
  await page.keyboard.type(query);
  expect((await answer).status()).toBe(200);
  await expect(
    command.getByRole('group', { name: 'Entities' }).getByRole('option').first(),
  ).toContainText(found.identifier);
  await expect(command.getByRole('option', { name: 'See all results' })).toBeVisible();
  await check('command search, results');
  await page.keyboard.press('Escape');
  await expect(command).toHaveCount(0);

  // A table, by default and sorted by title, descending.
  const paging = catalog.blueprints.find(
    (blueprint) => blueprint.identifier === catalog.paging.blueprint,
  );
  if (paging === undefined) throw new Error('The seed has no paging blueprint.');
  await page.goto(`/catalog/${paging.identifier}`);
  const table = page.getByRole('table', { name: paging.title });
  await expect(page.getByRole('heading', { level: 1, name: paging.title })).toBeVisible();
  await expect(table.locator('tbody tr')).not.toHaveCount(0);
  await check('table');
  await page.goto(`/catalog/${paging.identifier}?sort=title&order=desc`);
  await expect(table.getByRole('columnheader', { name: 'Title' })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  await expect(table.locator('tbody tr')).not.toHaveCount(0);
  await check('table, sorted');

  // An entity with a status: its details tab, then its related tab.
  const withStatus = catalog.status.entity;
  await page.goto(entityPath(withStatus));
  await expect(page.getByRole('heading', { level: 1, name: withStatus.title })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Details', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(main.getByRole('region', { name: 'Status', exact: true })).toBeVisible();
  await check('entity details');
  const related = catalog.relation.to;
  await page.goto(`${entityPath(related)}?tab=related`);
  await expect(page.getByRole('heading', { level: 1, name: related.title })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Related', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('table', { name: 'Related entities' })).toBeVisible();
  await check('entity related');

  // The search page: its prompt, and the results of a query.
  await page.goto('/search');
  await expect(main.getByRole('heading', { level: 1, name: 'Search results' })).toBeVisible();
  await expect(
    main.getByText('Type a query in the search box to search the catalog.'),
  ).toBeVisible();
  await check('search page, prompt');
  const results = nextGet(page, '/v1/search/entities', { q: query, limit: '50' });
  await page.goto(`/search?q=${query}`);
  expect((await results).status()).toBe(200);
  await expect(main.getByRole('link', { name: found.identifier, exact: true })).toBeVisible();
  await check('search page, results');

  // The not-found pages: an entity, a blueprint, and a path the router does not know.
  await page.goto(entityPath(missingEntity));
  await expect(main.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await check('not found, entity');
  await page.goto(`/catalog/${NOWHERE}`);
  await expect(main.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await check('not found, blueprint');
  await page.goto(`/${NOWHERE}/${NOWHERE}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await check('not found, unknown path');

  // The delete confirmation, then the step-up dialog of a session without MFA; both
  // cancelled, so the entity stays.
  const deletion = await openStepUpOverDelete(page, owned);
  await expect(
    deletion.confirmation.getByLabel('Remove the references other entities hold to it'),
  ).not.toBeChecked();
  await check('delete confirmation');
  const stepUp = await deletion.confirm();
  await expect(stepUp.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(stepUp.getByLabel('Authentication code')).toHaveCount(0);
  await check('step-up dialog, password');
  await cancelStepUpAndDelete(page, owned, deletion.confirmation, stepUp);
}

/**
 * The step-up dialog of a Visma Connect session, over the delete of the entity the
 * Visma Connect user created; cancelled before the round trip, so the entity stays.
 */
export async function tourVismaConnectStepUp(
  page: Page,
  seed: E2eSeed,
  guard: PageGuard,
  check: Checkpoint,
): Promise<void> {
  const owned = seed.tenants.a.catalog.dialogEntities.vismaConnect;
  guard.expectApiError(403, entityApiPath(owned));

  await signInWithVismaConnect(page, seed);
  const deletion = await openStepUpOverDelete(page, owned);
  const stepUp = await deletion.confirm();
  await expect(stepUp.getByRole('button', { name: 'Continue with Visma Connect' })).toBeVisible();
  await expect(stepUp.getByRole('textbox')).toHaveCount(0);
  await check('step-up dialog, Visma Connect');
  await cancelStepUpAndDelete(page, owned, deletion.confirmation, stepUp);
}
