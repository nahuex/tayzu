/**
 * 003 task 10.4 (design D11, D12 and Resolved decisions Q73, Q74, Q92): the session
 * gates end to end, against the stack of `scripts/ci/e2e.sh`, through the shared
 * fixture (every test also fails on a CSP violation, a console error, an undeclared
 * error answer or a request to another origin).
 *
 * - "A temporary password is a gate" and "A temporary password is changed": the seed's
 *   `temporaryPasswordChange` member, signed in under the temporary password the
 *   admin's create returned, asks for `/catalog/service`, meets the change-password
 *   page, changes the password and lands on `/catalog/service` (Q73's `returnTo`).
 * - "An admin without MFA must enrol": the seed's `adminWithoutMfa`, who is only signed
 *   in and never enrolled here, so the test can run in any order.
 * - "MFA enrolment completes only with a valid code": the seed's `mfaEnrolee`, a second
 *   admin without a factor that this test enrols. The code is computed from the secret
 *   the page shows, never from the seed.
 *
 * Every user here is this spec's own: no other spec signs them in.
 */
import type { Page } from '@playwright/test';

import { apiGet } from './fixtures/browser-api.js';
import { expect, test, totpCode, type SeedUser } from './fixtures/test.js';

test.use({ locale: 'en-US' });

const TOTP_STEP_SECONDS = 30;
/** Better Auth's refusal of a wrong code (Q74): a refused code, not a lost session. */
const VERIFY_TOTP_PATH = '/api/auth/two-factor/verify-totp';

/** Signs a user in from `/sign-in` with email and password only. */
async function signIn(page: Page, user: SeedUser): Promise<void> {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** The `gate` field of `GET /v1/me`, read from the page with its own cookies. */
async function sessionOf(page: Page): Promise<unknown> {
  const me = await apiGet(page, '/v1/me');
  expect(me.status).toBe(200);
  return me.body;
}

/**
 * Six digits that are not the code of any step near now (two steps on each side, wider
 * than any verifier's window), so the server must refuse them.
 */
function wrongTotpCode(secret: string): string {
  const now = Date.now() / 1000;
  const near = new Set(
    [-2, -1, 0, 1, 2].map((offset) => totpCode(secret, now + offset * TOTP_STEP_SECONDS)),
  );
  let candidate = (Number(totpCode(secret, now)) + 500_000) % 1_000_000;
  while (near.has(String(candidate).padStart(6, '0'))) {
    candidate = (candidate + 1) % 1_000_000;
  }
  return String(candidate).padStart(6, '0');
}

test('A temporary password is a gate, and is changed', async ({ page, seed }) => {
  const user = seed.tenants.a.users.temporaryPasswordChange;

  // GIVEN a user signed in with an unexpired temporary password
  await signIn(page, user);
  await expect(page).toHaveURL((url) => url.pathname === '/change-password');

  // WHEN they open `/catalog/service`
  await page.goto('/catalog/service');

  // THEN the app shows the change-password page, and `GET /v1/me` reports
  // `password_change_required`
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/change-password' &&
      url.searchParams.get('returnTo') === '/catalog/service',
  );
  await expect(page.getByRole('heading', { level: 1, name: 'Change your password' })).toBeVisible();
  expect(await sessionOf(page)).toEqual(
    expect.objectContaining({
      user: expect.objectContaining({ email: user.email }),
      gate: 'password_change_required',
    }),
  );

  // WHEN they enter the temporary password and a policy-compliant new password
  await page.getByLabel('Current password').fill(user.password);
  await page.getByLabel('New password', { exact: true }).fill(user.newPassword);
  await page.getByLabel('Confirm new password').fill(user.newPassword);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();

  // THEN the gate clears and they reach the page they asked for
  await expect(page).toHaveURL((url) => url.pathname === '/catalog/service');
  await expect(page.getByRole('heading', { level: 1, name: 'Service' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Catalog' })).toBeVisible();
  expect(await sessionOf(page)).toEqual(
    expect.objectContaining({
      user: expect.objectContaining({ email: user.email }),
      gate: 'none',
    }),
  );
});

test('An admin without MFA must enrol', async ({ page, seed }) => {
  const admin = seed.tenants.a.users.adminWithoutMfa;

  // GIVEN an admin with no enrolled factor
  // WHEN they sign in
  await signIn(page, admin);

  // THEN the app shows the MFA enrolment page, and `GET /v1/me` reports
  // `mfa_enrolment_required`
  await expect(page).toHaveURL((url) => url.pathname === '/mfa/enrol');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Set up two-factor authentication' }),
  ).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  expect(await sessionOf(page)).toEqual(
    expect.objectContaining({
      user: expect.objectContaining({ email: admin.email }),
      role: 'admin',
      mfa: { enrolled: false },
      gate: 'mfa_enrolment_required',
    }),
  );

  // Every other protected route sends the gated session back to its gate's page.
  await page.goto('/catalog/service');
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/mfa/enrol' && url.searchParams.get('returnTo') === '/catalog/service',
  );
  await expect(page.getByRole('navigation', { name: 'Catalog' })).toHaveCount(0);
});

test('MFA enrolment completes only with a valid code', async ({ page, seed, guard }) => {
  const admin = seed.tenants.a.users.mfaEnrolee;

  // GIVEN a user who must enrol
  await signIn(page, admin);
  await expect(page).toHaveURL((url) => url.pathname === '/mfa/enrol');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Set up two-factor authentication' }),
  ).toBeVisible();
  expect(await sessionOf(page)).toEqual(
    expect.objectContaining({ gate: 'mfa_enrolment_required', mfa: { enrolled: false } }),
  );

  // WHEN they confirm their password
  await page.getByLabel('Password', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  // AND scan the code: the QR code, and the same secret as text for manual entry
  await expect(page.getByRole('heading', { level: 2, name: 'Scan the QR code' })).toBeVisible();
  await expect(
    page.locator('main svg').filter({ hasText: 'QR code for your authenticator app' }),
  ).toBeVisible();
  const secret = ((await page.locator('main code').textContent()) ?? '').trim();
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  await expect(
    page.getByRole('list', { name: 'Backup codes' }).getByRole('listitem'),
  ).not.toHaveCount(0);
  await page.getByLabel('I have saved my backup codes').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const code = page.getByLabel('Authentication code');
  await expect(code).toBeVisible();

  // AND enter a wrong code: Better Auth refuses it with a `401` (Q74, Q92)
  guard.expectApiError(401, VERIFY_TOTP_PATH);
  await code.fill(wrongTotpCode(secret));
  await page.getByRole('button', { name: 'Verify', exact: true }).click();

  // THEN the wrong code is refused: the page stays on the code step, still gated
  await expect(page.getByRole('alert').filter({ hasText: 'The code is not valid.' })).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === '/mfa/enrol');
  await expect(code).toBeVisible();
  expect(await sessionOf(page)).toEqual(
    expect.objectContaining({ gate: 'mfa_enrolment_required', mfa: { enrolled: false } }),
  );

  // WHEN they enter a valid one, computed from the secret the page showed
  await code.fill(totpCode(secret, Date.now() / 1000));
  await page.getByRole('button', { name: 'Verify', exact: true }).click();

  // THEN the valid one enrols the factor, and the gate clears
  await expect(page).toHaveURL((url) => url.pathname === '/');
  await expect(page.getByRole('navigation', { name: 'Catalog' })).toBeVisible();
  expect(await sessionOf(page)).toEqual(
    expect.objectContaining({
      user: expect.objectContaining({ email: admin.email }),
      mfa: { enrolled: true },
      gate: 'none',
    }),
  );
});
