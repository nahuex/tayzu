/**
 * 003 task 10.2 (design D11, D12, D16): sign-in end to end, against the stack of
 * `scripts/ci/e2e.sh`, through the shared fixture (every test also fails on a CSP
 * violation, a console error or a request to another origin).
 *
 * - "Local sign-in with a second factor": tenant A's admin, email and password, then a
 *   TOTP code computed from the seeded secret.
 * - The shell with the sidebar, the theme toggle surviving a reload and sign-out: tenant
 *   A's member (no second factor), so no test but the first spends a TOTP code.
 * - "Spanish browser, no choice stored": a context whose locale is `es-AR`.
 *
 * TOTP codes: the suite shares one seeded admin with the other specs (one worker, in
 * order), and the seed itself already verified a code. A test never reuses a code: it
 * waits for the start of the next 30-second step and computes that step's code.
 */
import type { Page } from '@playwright/test';

import { apiGet } from './fixtures/browser-api.js';
import { expect, test, totpCode, type E2eSeed, type SeedUser } from './fixtures/test.js';

const TOTP_STEP_MS = 30_000;
/** After the step boundary, so the server's clock is in the same step. */
const STEP_MARGIN_MS = 1_000;

/** The code of a TOTP step no one has used yet: the next one, once it starts. */
async function unusedTotpCode(secret: string): Promise<string> {
  const now = Date.now();
  const nextStep = (Math.floor(now / TOTP_STEP_MS) + 1) * TOTP_STEP_MS;
  await new Promise((resolve) => setTimeout(resolve, nextStep - now + STEP_MARGIN_MS));
  return totpCode(secret, Date.now() / 1000);
}

async function fillCredentials(page: Page, user: SeedUser, submit: string): Promise<void> {
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: submit, exact: true }).click();
}

/** Signs a user without a second factor in from `/sign-in`, in English. */
async function signInWithoutMfa(page: Page, user: SeedUser): Promise<void> {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
  await fillCredentials(page, user, 'Sign in');
  await expect(page).toHaveURL((url) => url.pathname === '/');
}

/** A `localStorage` value of the page's origin (the e2e code has no DOM types). */
async function storedValue(page: Page, key: string): Promise<unknown> {
  return page.evaluate(`window.localStorage.getItem(${JSON.stringify(key)})`);
}

/** Whether the browser holds a Better Auth session cookie for the app's origin. */
async function hasSessionCookie(page: Page, origin: string): Promise<boolean> {
  const cookies = await page.context().cookies(origin);
  return cookies.some((cookie) => cookie.name.endsWith('better-auth.session_token'));
}

/** The sidebar: the navigation landmark of the shell. */
function sidebar(page: Page) {
  return page.getByRole('navigation', { name: 'Catalog' });
}

/**
 * The sidebar link of a blueprint, by its table's path: a system blueprint may share a
 * title with a tenant one (`_team` and `team` are both "Team").
 */
function sidebarLink(page: Page, identifier: string) {
  return sidebar(page).locator(`a[href="/catalog/${identifier}"]`);
}

/** Every seeded blueprint of tenant A is a link of the sidebar, to its table, by title. */
async function expectSeededBlueprints(page: Page, seed: E2eSeed): Promise<void> {
  for (const blueprint of seed.tenants.a.catalog.blueprints) {
    const link = sidebarLink(page, blueprint.identifier);
    await expect(link).toBeVisible();
    await expect(link).toHaveAccessibleName(blueprint.title);
  }
}

test.describe('sign-in, English browser', () => {
  test.use({ locale: 'en-US', colorScheme: 'light' });

  test('Local sign-in with a second factor', async ({ page, seed }) => {
    // Up to one TOTP step of waiting, on top of the flow itself.
    test.setTimeout(90_000);
    const admin = seed.tenants.a.users.admin;

    // GIVEN a user with TOTP enrolled
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();

    // WHEN they enter their email and password
    await fillCredentials(page, admin, 'Sign in');

    // The page asks for the second factor, and the session is not usable before it.
    const code = page.getByLabel('Authentication code');
    await expect(code).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === '/sign-in');
    expect(await hasSessionCookie(page, seed.appOrigin)).toBe(false);

    // AND then a valid code
    await code.fill(await unusedTotpCode(admin.totpSecret));
    await page.getByRole('button', { name: 'Verify', exact: true }).click();

    // THEN they reach the home page with their blueprints in the sidebar
    await expect(page).toHaveURL((url) => url.pathname === '/');
    await expectSeededBlueprints(page, seed);
    expect(await hasSessionCookie(page, seed.appOrigin)).toBe(true);
    const me = await apiGet(page, '/v1/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual(
      expect.objectContaining({
        user: expect.objectContaining({ email: admin.email }),
        gate: 'none',
      }),
    );
  });

  test('The shell shows the header, the user menu and the blueprint sidebar', async ({
    page,
    seed,
  }) => {
    const tenant = seed.tenants.a;
    const member = tenant.users.member;
    await signInWithoutMfa(page, member);

    // The header: product name, search trigger, locale selector, theme toggle, user menu.
    const header = page.getByRole('banner');
    await expect(header.getByText('Tayzu', { exact: true })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Language' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Theme' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'User menu' })).toBeVisible();

    // The landmarks and the skip link.
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeAttached();

    // The sidebar: every seeded blueprint, and the `_`-prefixed system ones last.
    await expectSeededBlueprints(page, seed);
    const hrefs: string[] = [];
    for (const link of await sidebar(page).getByRole('link').all()) {
      hrefs.push((await link.getAttribute('href')) ?? '');
    }
    const firstSystem = hrefs.findIndex((href) => href.startsWith('/catalog/_'));
    if (firstSystem !== -1) {
      expect(hrefs.slice(firstSystem).every((href) => href.startsWith('/catalog/_'))).toBe(true);
    }

    // A sidebar link opens the blueprint's table.
    const [first] = tenant.catalog.blueprints;
    if (first === undefined) throw new Error('The seed has no blueprint in tenant A.');
    await sidebarLink(page, first.identifier).click();
    await expect(page).toHaveURL((url) => url.pathname === `/catalog/${first.identifier}`);
    await expect(page.getByRole('heading', { level: 1, name: first.title })).toBeVisible();

    // The user menu: name, organization and role from the session, and sign-out.
    await header.getByRole('button', { name: 'User menu' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByText(member.name, { exact: true })).toBeVisible();
    await expect(menu.getByText(tenant.name, { exact: true })).toBeVisible();
    await expect(menu.getByText('Member', { exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  });

  test('The theme toggle survives a reload', async ({ page, seed }) => {
    await signInWithoutMfa(page, seed.tenants.a.users.member);
    const html = page.locator('html');
    // The browser prefers light, and nothing is stored: the system theme is light.
    await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);

    await page.getByRole('button', { name: 'Theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
    expect(await storedValue(page, 'tayzu.theme')).toBe('dark');

    await page.reload();
    await expect(sidebar(page)).toBeVisible();
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
    await page.getByRole('button', { name: 'Theme' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeChecked();
    await expect(page.getByRole('menuitemradio', { name: 'Light' })).not.toBeChecked();
    await expect(page.getByRole('menuitemradio', { name: 'System' })).not.toBeChecked();

    // Back to light, which also survives a reload.
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
    await page.reload();
    await expect(sidebar(page)).toBeVisible();
    await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
    expect(await storedValue(page, 'tayzu.theme')).toBe('light');
  });

  test('Sign-out ends the session and returns to the sign-in page', async ({
    page,
    seed,
    guard,
  }) => {
    await signInWithoutMfa(page, seed.tenants.a.users.member);
    await expect(sidebar(page)).toBeVisible();

    await page.getByRole('button', { name: 'User menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();

    await expect(page).toHaveURL((url) => url.pathname === '/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
    expect(await hasSessionCookie(page, seed.appOrigin)).toBe(false);

    // The session is gone on the server, not only in the page: a protected page now
    // sends the visitor to sign-in, through the gate's `401` (Q92).
    guard.expectApiError(401, '/v1/me');
    await page.goto('/');
    await expect(page).toHaveURL((url) => url.pathname === '/sign-in');
    await expect(sidebar(page)).toHaveCount(0);
  });
});

test.describe('sign-in, Spanish browser', () => {
  test.use({ locale: 'es-AR' });

  test('Spanish browser, no choice stored', async ({ page, seed, guard }) => {
    // GIVEN a browser whose language is `es-AR` and no stored choice
    await page.goto('/sign-in');
    expect(await page.evaluate('navigator.language')).toBe('es-AR');
    expect(await storedValue(page, 'tayzu.locale')).toBeNull();

    // WHEN the user opens the app (signed out: the gate's `401` sends it to sign-in, Q92)
    guard.expectApiError(401, '/v1/me');
    await page.goto('/');

    // THEN the app is in Spanish and the document language is `es`
    await expect(page).toHaveURL((url) => url.pathname === '/sign-in');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Iniciar sesión en Tayzu' }),
    ).toBeVisible();
    await expect(page.getByLabel('Correo electrónico')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Iniciar sesión con Visma Connect' }),
    ).toBeVisible();

    // Signed in, the shell is in Spanish too, with the blueprint titles in `es`.
    const member = seed.tenants.a.users.member;
    await page.getByLabel('Correo electrónico').fill(member.email);
    await page.getByLabel('Contraseña', { exact: true }).fill(member.password);
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.getByRole('navigation', { name: 'Catálogo' })).toBeVisible();
    const spanishTitles: Record<string, string> = {
      team: 'Equipo',
      service: 'Servicio',
      component: 'Componente',
    };
    for (const [identifier, title] of Object.entries(spanishTitles)) {
      const link = page
        .getByRole('navigation', { name: 'Catálogo' })
        .locator(`a[href="/catalog/${identifier}"]`);
      await expect(link).toHaveAccessibleName(title);
    }
    await expect(page.getByRole('button', { name: 'Menú de usuario' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tema' })).toBeVisible();
    // Opening the app stored no choice: the locale still comes from the browser.
    expect(await storedValue(page, 'tayzu.locale')).toBeNull();
  });
});
