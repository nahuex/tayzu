/**
 * 003 task 10.5 (design D4, D11 and Resolved decisions Q51, Q75, Q92): local step-up end
 * to end, on entity delete, against the stack of `scripts/ci/e2e.sh`, through the shared
 * fixture (every test also fails on a CSP violation, a console error, an undeclared
 * error answer or a request to another origin).
 *
 * - "A local user verifies with TOTP": the seed's `stepUpTotp` member deletes the entity
 *   they created (`catalog_entity.yaml`: a member deletes what they created). Signing in
 *   through the TOTP challenge is itself a fresh verification for five minutes
 *   (`STEP_UP_FRESHNESS_MS` of `@tayzu/auth`), so the test waits until that window has
 *   passed: only then does the session have "no fresh verification", as the scenario's
 *   GIVEN says. That costs a little over five minutes.
 * - "A user without MFA verifies with the password": the seed's `stepUpPassword` member
 *   deletes the entity they created. A password sign-in records no verification, so the
 *   first delete needs step-up right away.
 *
 * In both, the first delete is answered `403 AUTH_STEP_UP_REQUIRED` (declared, Q92), the
 * dialog asks for the factor of the session, and after the verification the deletion
 * completes with no further action of the user. The spec lets the app retry the request
 * once (a MAY, Q75), so the test asserts the outcome, never the number of attempts. Each test uses its own
 * user and entity, so the order of the specs does not matter.
 */
import type { Page, Response } from '@playwright/test';

import { apiGet } from './fixtures/browser-api.js';
import { expect, test, totpCode, type SeedEntity, type SeedUser } from './fixtures/test.js';

test.use({ locale: 'en-US' });

const TOTP_STEP_MS = 30_000;
/** After the step boundary, so the server's clock is in the same step. */
const STEP_MARGIN_MS = 1_000;
/** `STEP_UP_FRESHNESS_MS` of `@tayzu/auth` (002 design D4): a verification is fresh for 5 minutes. */
const STEP_UP_FRESHNESS_MS = 5 * 60 * 1000;
/** Past the freshness window, so the server's marker has certainly expired. */
const FRESHNESS_MARGIN_MS = 5_000;

/** The code of a TOTP step no one has used yet: the next one, once it starts. */
async function unusedTotpCode(secret: string): Promise<string> {
  const now = Date.now();
  const nextStep = (Math.floor(now / TOTP_STEP_MS) + 1) * TOTP_STEP_MS;
  await new Promise((resolve) => setTimeout(resolve, nextStep - now + STEP_MARGIN_MS));
  return totpCode(secret, Date.now() / 1000);
}

/** The entity's `entities.get` and `entities.delete` route. */
function entityApiPath(entity: SeedEntity): string {
  return `/v1/blueprints/${entity.blueprint}/entities/${entity.identifier}`;
}

function entityPath(entity: SeedEntity): string {
  return `/catalog/${entity.blueprint}/${entity.identifier}`;
}

async function fillCredentials(page: Page, user: SeedUser): Promise<void> {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** The answers to `DELETE` of the entity, in order, as they arrive. */
function recordDeletes(page: Page, entity: SeedEntity): Response[] {
  const answers: Response[] = [];
  page.on('response', (response) => {
    const request = response.request();
    if (request.method() !== 'DELETE') return;
    if (new URL(request.url()).pathname === entityApiPath(entity)) answers.push(response);
  });
  return answers;
}

/**
 * Opens the entity page, clicks "Delete entity" and confirms; the first delete is
 * answered `403 AUTH_STEP_UP_REQUIRED` (Q92). Returns the step-up dialog.
 */
async function deleteAndMeetStepUp(page: Page, entity: SeedEntity) {
  await page.goto(entityPath(entity));
  await expect(page.getByRole('heading', { level: 1, name: entity.title })).toBeVisible();
  await page.getByRole('button', { name: 'Delete entity' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete this entity?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();

  const stepUp = page.getByRole('dialog', { name: 'Verify your identity' });
  await expect(stepUp).toBeVisible();
  return stepUp;
}

/** THEN the deletion completes: the app is back on the table, and the entity is gone. */
async function expectDeleted(
  page: Page,
  entity: SeedEntity,
  deletes: readonly Response[],
  expectApiError: (status: number, path: string) => void,
): Promise<void> {
  await expect(page).toHaveURL((url) => url.pathname === `/catalog/${entity.blueprint}`);
  await expect(page.getByRole('dialog', { name: 'Verify your identity' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Delete this entity?' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: entity.title, exact: true })).toHaveCount(0);
  // The first delete was refused for step-up, and the last one, after the verification
  // and with no further action of the user, succeeded. How the app gets there (one
  // retry) is the spec's MAY, so the number of attempts is not asserted.
  const statuses = deletes.map((answer) => answer.status());
  expect(statuses[0]).toBe(403);
  expect(statuses.at(-1)).toBeGreaterThanOrEqual(200);
  expect(statuses.at(-1)).toBeLessThan(300);
  // Gone: `entities.get` answers `404` (Q92).
  expectApiError(404, entityApiPath(entity));
  expect((await apiGet(page, entityApiPath(entity))).status).toBe(404);
}

test('A local user verifies with TOTP', async ({ page, seed, guard }) => {
  // One TOTP step to sign in, the freshness window, then one more TOTP step.
  test.setTimeout(STEP_UP_FRESHNESS_MS + 3 * 60_000);
  const user = seed.tenants.a.users.stepUpTotp;
  const entity = seed.tenants.a.catalog.stepUpDeletable.totp;

  // GIVEN a signed-in user with TOTP
  await fillCredentials(page, user);
  const signInCode = page.getByLabel('Authentication code');
  await expect(signInCode).toBeVisible();
  await signInCode.fill(await unusedTotpCode(user.totpSecret));
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/');
  const verifiedAt = Date.now();
  const me = await apiGet(page, '/v1/me');
  expect(me.status).toBe(200);
  expect(me.body).toEqual(
    expect.objectContaining({
      user: expect.objectContaining({ email: user.email }),
      signInMethod: 'password',
      mfa: { enrolled: true },
      gate: 'none',
    }),
  );

  // AND no fresh verification: the sign-in's own verification has expired
  await new Promise((resolve) =>
    setTimeout(resolve, verifiedAt + STEP_UP_FRESHNESS_MS + FRESHNESS_MARGIN_MS - Date.now()),
  );

  // WHEN they delete an entity
  const deletes = recordDeletes(page, entity);
  guard.expectApiError(403, entityApiPath(entity));
  const stepUp = await deleteAndMeetStepUp(page, entity);

  // The prompt of a local session with MFA: a code, and no password field.
  const code = stepUp.getByLabel('Authentication code');
  await expect(code).toBeVisible();
  await expect(stepUp.locator('input[type="password"]')).toHaveCount(0);
  await expect(stepUp.getByRole('button', { name: 'Use a backup code' })).toBeVisible();
  // The refused delete changed nothing.
  expect((await apiGet(page, entityApiPath(entity))).status).toBe(200);

  // AND enter a valid code in the prompt
  await code.fill(await unusedTotpCode(user.totpSecret));
  await stepUp.getByRole('button', { name: 'Verify', exact: true }).click();

  // THEN the deletion completes
  await expectDeleted(page, entity, deletes, guard.expectApiError);
});

test('A user without MFA verifies with the password', async ({ page, seed, guard }) => {
  const user = seed.tenants.a.users.stepUpPassword;
  const entity = seed.tenants.a.catalog.stepUpDeletable.password;

  // GIVEN a signed-in user without a second factor
  await fillCredentials(page, user);
  await expect(page).toHaveURL((url) => url.pathname === '/');
  const me = await apiGet(page, '/v1/me');
  expect(me.status).toBe(200);
  expect(me.body).toEqual(
    expect.objectContaining({
      user: expect.objectContaining({ email: user.email }),
      signInMethod: 'password',
      mfa: { enrolled: false },
      gate: 'none',
    }),
  );

  // WHEN they delete an entity
  const deletes = recordDeletes(page, entity);
  guard.expectApiError(403, entityApiPath(entity));
  const stepUp = await deleteAndMeetStepUp(page, entity);

  // The prompt of a local session without MFA: the password, and no code field.
  const password = stepUp.getByLabel('Password', { exact: true });
  await expect(password).toBeVisible();
  await expect(stepUp.getByLabel('Authentication code')).toHaveCount(0);
  // The refused delete changed nothing.
  expect((await apiGet(page, entityApiPath(entity))).status).toBe(200);

  // AND re-enter their password in the prompt
  await password.fill(user.password);
  await stepUp.getByRole('button', { name: 'Verify', exact: true }).click();

  // THEN the deletion completes
  await expectDeleted(page, entity, deletes, guard.expectApiError);
});
