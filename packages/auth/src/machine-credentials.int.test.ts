/**
 * Integration test for task 5.1 (design D5; `specs/auth-and-rbac/spec.md`,
 * "Machine credentials").
 *
 * "An `apiKey` plugin config `machine-credential` (`references:
 * "organization"`), and an admin-only creation procedure fixing `actorKind`
 * (`integration`|`agent`) at creation." This file covers exactly the one
 * scenario task 5.1's own Verify clause names, quoted from
 * `specs/auth-and-rbac/spec.md`:
 *
 * #### Scenario: Credential is shown only once
 * - WHEN a machine credential is created
 * - THEN its secret appears in the creation response and in no later read of
 *   that credential
 *
 * The requirement text above that scenario (same spec section): "The system
 * MUST let an organization admin create a named machine credential of a
 * fixed kind (`integration` or `agent`, chosen at creation): a client id and
 * a client secret, generated once, returned only in the creation response,
 * and stored hashed thereafter." Design D5: "The long-lived credential is an
 * `apiKey` plugin key, config `machine-credential` (`references:
 * "organization"`, `defaultPrefix: "tayzu_mc_"`), created by an admin. Its
 * `id` is the client id; its generated key is the client secret, shown once,
 * hashed thereafter (Better Auth default -- `disableKeyHashing` is never
 * set)." and "`actorKind` (`integration` or `agent`) is fixed at
 * credential-creation time via the config's `metadata`, never chosen by the
 * caller of `POST /v1/auth/token`."
 *
 * ## Module under test, and why its shape is this file's own design decision
 *
 * No file named `machine-credentials.ts` (or anything similar) exists
 * anywhere in `packages/auth/src` yet (confirmed by listing the directory
 * before writing this file) -- task 5.1 is genuinely new production code, not
 * an extension of an existing module. Design D5 names the mechanism
 * (`auth.api.createApiKey` against a `machine-credential` config) but no
 * concrete wrapper-function signature, so -- the same "flagged here, in case
 * the green phase settles on a different shape" practice `step-up.int.
 * test.ts`'s own module doc comment establishes for this package -- this
 * file assumes `./machine-credentials.ts` exports:
 *
 * - `createMachineCredential(auth, params)`, the same `functionName(auth,
 *   params)` convention `./__fixtures__/admin-user.ts`'s own
 *   `createAdminUser`/`bootstrapTestTenant` and `../scripts/bootstrap-
 *   admin.ts`'s own `bootstrapAdmin` already establish for this package's
 *   admin-only creation paths, rather than the `create*({ auth })` factory
 *   `./context-resolver.ts`/`./step-up.ts` use for long-lived guards -- this
 *   is a one-shot action, not a reusable guard held across requests.
 * - `CreateMachineCredentialParams`: `headers` (a real `Headers` carrying the
 *   calling admin's session cookie, forwarded to `auth.api.createApiKey` so
 *   Better Auth's own organization-membership/permission check --
 *   `checkOrgApiKeyPermission`, verified against the installed
 *   `@better-auth/api-key@1.7.6` source, `dist/index.mjs` -- decides
 *   admin-only-ness, rather than this package reimplementing a second role
 *   check); `organizationId`; `name`; `actorKind` (`'integration' |
 *   'agent'`, the two literal values the requirement text names).
 * - `CreatedMachineCredential`: `id` (the client id), `secret` (the client
 *   secret, Better Auth's own `key` field under this function's own name --
 *   "shown once" is this field's entire reason to exist), `name`,
 *   `actorKind`, `organizationId`.
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `./machine-credentials.js` does not exist (confirmed above), so the test
 * below fails at import time with a "Cannot find module" error -- the one
 * acceptable missing-module condition this assignment's own instructions
 * name ("acceptable only for the module under test"). Every other import in
 * this file (`./auth.js`, `./persistence/schema.js`, `./__fixtures__/
 * admin-user.js`, `./__fixtures__/registered-harness.js`, `@tayzu/db`)
 * already exists and is exercised unchanged by every other int test file in
 * this package.
 *
 * ## Why "no later read" is checked against Better Auth's own `getApiKey`, not a second wrapper
 *
 * "In no later read of that credential" is checked against `auth.api.
 * getApiKey` directly -- Better Auth's own installed response type for this
 * endpoint (`@better-auth/api-key@1.7.6`, `dist/index-BJOGXZav.d.mts`:
 * `getApiKey`'s success type has no `key` property at all, unlike `create
 * ApiKey`'s, which does) already omits the raw key on every read, by the
 * library's own construction -- this file asserts against that real,
 * independently-callable endpoint rather than trusting `./machine-
 * credentials.ts` not to leak the secret through some second read path of
 * its own it might add later. The same admin session (`cookie`) that created
 * the credential reads it back, since `getApiKey`'s own organization-
 * reference branch requires a session belonging to a member of that
 * organization (same `checkOrgApiKeyPermission` check as create, this time
 * for the `"read"` action).
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same shared-`DATABASE_URL` / `runMigrations`-per-suite,
 * `randomUUID()`-per-test isolation pattern as every other int test file in
 * this package. The admin user is provisioned through the admin-creation
 * path (`./__fixtures__/admin-user.js`'s `bootstrapTestTenant`, task 18.1),
 * never Better Auth's own `/sign-up/email` route (`disableSignUp: true`,
 * task 18.2) -- as the organization's own creator, this user holds Better
 * Auth's default `"owner"` organization role, which `@better-auth/api-key`'s
 * `allowCreatorAllPermissions: true` grants full API-key permissions
 * regardless of any explicit access-control statement, satisfying "an
 * organization admin" without this file needing to configure organization
 * access-control statements itself. Every request `bootstrapTestTenant`
 * makes carries its own fresh, random `x-forwarded-for` IP (`randomIp()`),
 * per this task's own instructions, so no rate limiter interferes.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations, withTenantTransaction } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (task 2.4; design D1; `packages/observability/
// CLAUDE.md`, "Import order"): the harness must register before `./auth.js`'s
// real module runs, before it (and `./machine-credentials.js`, once it
// exists) create their tracer, meter instruments and logger at import time.
// `./__fixtures__/admin-user.js`'s own import of `../auth.js` is type-only
// (erased at compile time, `verbatimModuleSyntax`), so it carries no runtime
// ordering weight -- same reasoning as every other int test file in this
// package.
import { bootstrapTestTenant } from './__fixtures__/admin-user.js';
import './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
// The module under test (task 5.1): does not exist yet (module doc comment,
// "Why this is expected to fail for the right reason right now").
import { createMachineCredential } from './machine-credentials.js';
import type { CreatedMachineCredential } from './machine-credentials.js';
// The module under test (task 5.2, added by this task -- see this file's
// second module doc comment block below, right above the new test). Named
// export expected not to exist yet, alongside the already-existing
// `createMachineCredential`/`CreatedMachineCredential` above.
import { revokeMachineCredential } from './machine-credentials.js';
import * as authSchema from './persistence/schema.js';

/** Same fail-fast pattern as every other int test file in this repo. */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function connect(url: string): ReturnType<typeof drizzle<typeof authSchema>> {
  return drizzle(url, { schema: authSchema });
}

type TestDb = ReturnType<typeof connect>;

async function endQuietly(closeable: {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}): Promise<void> {
  closeable.on('error', () => {
    // Expected only during teardown; nothing left to report it to.
  });
  await closeable.end();
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function randomEmail(): string {
  return `machine-credential-${randomUUID()}@example.test`;
}

function randomSlug(): string {
  return `machine-credential-org-${randomUUID()}`;
}

/** A password long enough for Better Auth's default 8-character minimum. */
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';
const TEST_ADMIN_NAME = 'Machine Credential Test Admin';

/**
 * design D5: the one `apiKey` plugin config this task registers, quoted
 * verbatim from the design ("config `machine-credential`").
 */
const MACHINE_CREDENTIAL_CONFIG_ID = 'machine-credential';

/**
 * The narrow slice of Better Auth's own `getApiKey` response
 * (`@better-auth/api-key@1.7.6`, `dist/index-BJOGXZav.d.mts`) this file
 * reads -- deliberately does not declare a `key` field, since the installed
 * type never carries one on this endpoint (see this file's own module doc
 * comment, "Why 'no later read' is checked against Better Auth's own
 * `getApiKey`, not a second wrapper").
 */
interface GetApiKeyResult {
  readonly id: string;
}

/**
 * The narrow slice of Better Auth's own `verifyApiKey` response
 * (`@better-auth/api-key@1.7.6`, `dist/index-BJOGXZav.d.mts`) task 5.2's own
 * new test reads below -- design D5's own words for the token endpoint's
 * mechanism: "It calls `auth.api.verifyApiKey({ body: { key } })`". Only the
 * `valid` boolean is read; the installed type's `error`/`key` union members
 * carry no field this test needs.
 */
interface VerifyApiKeyResult {
  readonly valid: boolean;
}

interface AuthApiSurface {
  getApiKey(args: {
    query: { readonly id: string; readonly configId?: string };
    headers: Headers;
  }): Promise<GetApiKeyResult>;
  verifyApiKey(args: {
    body: { readonly key: string; readonly configId?: string };
  }): Promise<VerifyApiKeyResult>;
}

function apiOf(auth: AuthInstance): AuthApiSurface {
  return auth.api as AuthApiSurface;
}

describe('Machine credentials (task 5.1, design D5)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let api: AuthApiSurface;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    api = apiOf(auth);
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  it('Credential is shown only once', async () => {
    // Setup for "an organization admin" (requirement text above the
    // scenario): provisioned through the admin-creation path (task 18.1),
    // the organization's own creator -- holds Better Auth's default "owner"
    // organization role (see this file's own module doc comment).
    const admin = await bootstrapTestTenant(auth, {
      name: TEST_ADMIN_NAME,
      email: randomEmail(),
      password: TEST_PASSWORD,
      organizationName: 'Machine Credential Test Org',
      organizationSlug: randomSlug(),
      ip: randomIp(),
    });
    const headers = new Headers({ cookie: admin.cookie });

    // WHEN "a machine credential is created".
    const created: CreatedMachineCredential = await createMachineCredential(auth, {
      headers,
      organizationId: admin.organizationId,
      name: 'CI pipeline credential',
      actorKind: 'integration',
    });

    // THEN "its secret appears in the creation response
    expect(typeof created.secret, 'the creation response carries a secret string').toBe('string');
    expect(
      created.secret.length,
      'the creation response carries a non-empty secret',
    ).toBeGreaterThan(0);

    // AND ... in no later read of that credential": Better Auth's own
    // `getApiKey` endpoint, read back through the same admin session, never
    // returns the raw key at all, by the library's own construction (see
    // this file's own module doc comment).
    const laterRead = await api.getApiKey({
      query: { id: created.id, configId: MACHINE_CREDENTIAL_CONFIG_ID },
      headers,
    });
    expect(laterRead.id, 'the later read resolves the same credential').toBe(created.id);
    expect(
      laterRead,
      'no later read exposes the secret under Better Auth’s own field name',
    ).not.toHaveProperty('key');
    expect(
      laterRead,
      'no later read exposes the secret under this wrapper’s own field name either',
    ).not.toHaveProperty('secret');
  });

  /**
   * Task 5.2 (design D5; `specs/auth-and-rbac/spec.md`, "Machine
   * credentials"). Task 5.2's own Verify clause, quoted from
   * `openspec/changes/002-auth-and-rbac/tasks.md`: "A revoke procedure (no
   * in-place rotation). Verify: `machine-credentials.int.test.ts` covers
   * that a revoked credential's id can no longer authenticate at the token
   * endpoint (used together with 5.3)." Unlike every other task in this
   * change, 5.2's own Verify clause names no quoted spec scenario of its
   * own -- the spec's "Revoked credential is rejected" scenario (`WHEN` its
   * client id and secret are posted to `POST /v1/auth/token`, `THEN` it
   * fails with `AUTH_INVALID_CREDENTIALS`) is task 5.3's own scenario to
   * cover, end-to-end, in `token-exchange.int.test.ts` (task 5.3's own
   * Verify clause names that file and that scenario explicitly). This test
   * instead covers the requirement text one level below the not-yet-built
   * token endpoint itself, at the exact mechanism design D5 names for it:
   * "A new procedure, `POST /v1/auth/token` ... calls `auth.api.
   * verifyApiKey({ body: { key } })`; on success it mints a 1-hour token ...
   * On failure it returns `AUTH_INVALID_CREDENTIALS`." -- and the
   * requirement text above the spec's scenarios: "The admin MUST be able to
   * revoke a credential; there is no in-place rotation, only
   * revoke-and-recreate." "used together with 5.3" reads as: this test
   * establishes, ahead of the token-endpoint wrapper task 5.3 adds, that
   * revocation actually disables the credential at `verifyApiKey` --  the
   * one call 5.3's own wrapper will make on every `POST /v1/auth/token`
   * request -- so 5.3's own end-to-end test can build on a revoke path
   * already proven to work at this layer.
   *
   * ## Module under test
   *
   * `revokeMachineCredential(auth, params)`, the same `functionName(auth,
   * params)` convention this file's own module doc comment already
   * establishes for `createMachineCredential`. Assumed shape, following that
   * same convention and this task's own text ("no in-place rotation" -- a
   * revoke, not an update, so this wrapper returns nothing the caller could
   * mistake for a rotated credential):
   *
   * - `RevokeMachineCredentialParams`: `headers` (a real `Headers` carrying
   *   the calling admin's session cookie, forwarded so Better Auth's own
   *   `checkOrgApiKeyPermission` -- this time for the `"update"` action,
   *   `@better-auth/api-key@1.7.6`'s installed source,
   *   `dist/index.mjs`, `updateApiKey`'s own handler -- decides admin-only
   *   -ness, the same pattern `createMachineCredential` already
   *   establishes); `id` (the credential's client id, `CreatedMachineCredential`
   *   ['id']` from task 5.1). No `organizationId` parameter: Better Auth's
   *   own `updateApiKey` handler looks the key up by `id` first and derives
   *   the organization to check permission against from the stored key's own
   *   `referenceId`, so this wrapper does not need to be told it separately
   *   (confirmed against the installed source at the same path).
   * - Return type: `Promise<void>` -- nothing in the requirement text or
   *   design D5 has this task's caller read anything back from a revoke.
   *
   * ## Why this is expected to fail for the right reason right now
   *
   * `revokeMachineCredential` does not exist anywhere in `./machine-
   * credentials.ts` yet (confirmed by reading that file before writing this
   * test) -- only `createMachineCredential`/`CreatedMachineCredential`
   * (task 5.1) are exported today. The import this file adds above therefore
   * fails at import time -- a missing named export from the module under
   * test, the one condition this assignment's own instructions call
   * acceptable ("acceptable only for the module under test"). Every other
   * import this test adds or reuses (`./auth.js`, `./__fixtures__/
   * admin-user.js`, `@better-auth/api-key`'s installed `verifyApiKey`
   * response shape) is already exercised, unchanged, by the existing test
   * above.
   *
   * ## Why this test asserts against `verifyApiKey` directly, not a not-yet-
   * built token-endpoint wrapper
   *
   * `POST /v1/auth/token` (task 5.3) does not exist yet either -- this test
   * would have no endpoint to call even if it wanted one. Design D5 names
   * `auth.api.verifyApiKey({ body: { key } })` as that endpoint's own,
   * literal first step, so asserting the credential's raw secret (the one
   * value a `POST /v1/auth/token` caller would present) no longer verifies
   * through that exact call, after revocation, is a direct, spec-faithful
   * check of "can no longer authenticate at the token endpoint" without
   * this file needing task 5.3's own wrapper to exist first. `configId:
   * 'machine-credential'` is required on this call: `./auth.ts` registers
   * only that one named `apiKey` config (no config with an implicit
   * `configId: 'default'`), and the installed `resolveConfiguration` throws
   * `NO_DEFAULT_API_KEY_CONFIGURATION_FOUND` when `configId` is omitted and
   * no default-named config exists (confirmed against the installed source
   * at the same path as above).
   */
  it("A revoked credential's id can no longer authenticate at the token endpoint", async () => {
    // Setup: same admin-creation and credential-creation path as the
    // existing test above.
    const admin = await bootstrapTestTenant(auth, {
      name: TEST_ADMIN_NAME,
      email: randomEmail(),
      password: TEST_PASSWORD,
      organizationName: 'Machine Credential Test Org',
      organizationSlug: randomSlug(),
      ip: randomIp(),
    });
    const headers = new Headers({ cookie: admin.cookie });
    const created: CreatedMachineCredential = await createMachineCredential(auth, {
      headers,
      organizationId: admin.organizationId,
      name: 'CI pipeline credential',
      actorKind: 'integration',
    });

    // Precondition: before revocation, the credential's secret verifies
    // through the exact call design D5 names for the token endpoint's own
    // mechanism -- otherwise a false "no longer authenticates" below would
    // prove nothing.
    const beforeRevoke = await api.verifyApiKey({
      body: { key: created.secret, configId: MACHINE_CREDENTIAL_CONFIG_ID },
    });
    expect(
      beforeRevoke.valid,
      'the credential authenticates before revocation, so the later failure is caused by revocation',
    ).toBe(true);

    // WHEN "an admin revokes the credential" (task 5.2's own Verify clause).
    await revokeMachineCredential(auth, { headers, id: created.id });

    // THEN "a revoked credential's id can no longer authenticate at the
    // token endpoint" (task 5.2's own Verify clause) -- the same
    // `verifyApiKey` call the token endpoint's own mechanism (design D5)
    // makes, using the same still-known secret, now fails.
    const afterRevoke = await api.verifyApiKey({
      body: { key: created.secret, configId: MACHINE_CREDENTIAL_CONFIG_ID },
    });
    expect(
      afterRevoke.valid,
      'the revoked credential no longer authenticates at the token endpoint’s own mechanism',
    ).toBe(false);
  });
});

/**
 * Task 5.6 (design D21; `specs/auth-and-rbac/spec.md`, "Machine credentials").
 * Task 5.6's Verify clause (`tasks.md`): "`machine-credentials.int.test.ts`
 * covers 'Revocation is recorded in the revocation list, not only disabled at
 * the apiKey layer'." That scenario title does not appear verbatim in any
 * `spec.md` under `specs/` (searched before writing this); the governing text
 * is D21: "Revocation itself (D5's existing revoke procedure) writes one row
 * here in the same operation that disables the underlying `apiKey` config
 * row, so the two can never disagree about whether a credential is revoked."
 *
 * ## Production symbols expected (flagged for the green phase)
 *
 * `revokeMachineCredential(auth, params)` gains two REQUIRED-by-design
 * params (see the conflict note in the task report about the untouched 5.2
 * test, which calls it with `{ headers, id }` only):
 * - `pool`: a `pg` `Pool` running as `tayzu_app`, used through
 *   `withTenantTransaction(pool, { tenantId }, ...)`;
 * - `tenantId`: from the trusted host context, never from input.
 * The revocation insert is `INSERT INTO machine_credential_revocation
 * (credential_id, revoked_at, tenant_id) ... ON CONFLICT DO NOTHING`
 * (`tayzu_app` holds only SELECT/INSERT, migration 0009).
 *
 * ## Fail-closed ordering (asserted below)
 *
 * The apiKey row (`auth` schema, `tayzu_auth`) and the revocation row
 * (`public`, `tayzu_app`) are on different pools/roles and cannot share one
 * transaction, so the ordering is what keeps them from disagreeing in the
 * dangerous direction: the revocation row must be written FIRST, then the
 * apiKey disabled. If the insert fails, the operation rejects and the key
 * must not have been disabled. The last test asserts "never disabled without
 * a revocation row".
 */
describe('Machine credential revocation list (task 5.6, design D21)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let api: AuthApiSurface;
  let appPool: TestDb['$client'];

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    api = apiOf(auth);
    // A pool that runs every query as `tayzu_app` (same technique as
    // `@tayzu/db`'s own harness), so the row is written and read under the
    // real `tenant_isolation` policy.
    appPool = connect(databaseUrl()).$client;
    appPool.on('connect', (client) => {
      void client.query('SET ROLE tayzu_app');
    });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(appPool);
    await endQuietly(db.$client);
  });

  interface RevocationRow {
    readonly credential_id: string;
    readonly tenant_id: string;
    readonly revoked_at: Date;
  }

  async function revocationRows(tenantId: string, id: string): Promise<readonly RevocationRow[]> {
    return withTenantTransaction(appPool, { tenantId }, async (client) => {
      const result = await client.query<RevocationRow>(
        'select credential_id, tenant_id, revoked_at from machine_credential_revocation where credential_id = $1',
        [id],
      );
      return result.rows;
    });
  }

  async function newCredential(): Promise<{
    headers: Headers;
    tenantId: string;
    created: CreatedMachineCredential;
  }> {
    const admin = await bootstrapTestTenant(auth, {
      name: TEST_ADMIN_NAME,
      email: randomEmail(),
      password: TEST_PASSWORD,
      organizationName: 'Machine Credential Test Org',
      organizationSlug: randomSlug(),
      ip: randomIp(),
    });
    const headers = new Headers({ cookie: admin.cookie });
    const created = await createMachineCredential(auth, {
      headers,
      organizationId: admin.organizationId,
      name: 'CI pipeline credential',
      actorKind: 'integration',
    });
    return { headers, tenantId: admin.organizationId, created };
  }

  it('Revocation is recorded in the revocation list, not only disabled at the apiKey layer', async () => {
    const { headers, tenantId, created } = await newCredential();
    expect(
      await revocationRows(tenantId, created.id),
      'no revocation row exists before the credential is revoked',
    ).toHaveLength(0);

    // WHEN the admin revokes the credential.
    await revokeMachineCredential(auth, { headers, id: created.id, pool: appPool, tenantId });

    // THEN the apiKey layer no longer verifies it ...
    const verified = await api.verifyApiKey({
      body: { key: created.secret, configId: MACHINE_CREDENTIAL_CONFIG_ID },
    });
    expect(verified.valid, 'the apiKey row is disabled').toBe(false);

    // AND the revocation list records it, under the host-supplied tenant.
    const rows = await revocationRows(tenantId, created.id);
    expect(rows, 'exactly one revocation row is written').toHaveLength(1);
    expect(rows[0]?.credential_id).toBe(created.id);
    expect(rows[0]?.tenant_id, 'the row carries the host-context tenant').toBe(tenantId);
    expect(rows[0]?.revoked_at, 'revoked_at is set').toBeInstanceOf(Date);

    // AND another tenant cannot see the row (RLS: looks like not found).
    expect(await revocationRows(randomUUID(), created.id)).toHaveLength(0);
  });

  it('A repeated revoke does not fail and leaves a single revocation row', async () => {
    const { headers, tenantId, created } = await newCredential();
    await revokeMachineCredential(auth, { headers, id: created.id, pool: appPool, tenantId });
    await expect(
      revokeMachineCredential(auth, { headers, id: created.id, pool: appPool, tenantId }),
    ).resolves.toBeUndefined();
    expect(await revocationRows(tenantId, created.id)).toHaveLength(1);
  });

  it('Revocation fails closed: a failed revocation write never leaves the apiKey disabled without a row', async () => {
    const { headers, tenantId, created } = await newCredential();
    // A pool that can no longer run queries: the revocation insert must fail.
    const brokenPool = connect(databaseUrl()).$client;
    await endQuietly(brokenPool);

    await expect(
      revokeMachineCredential(auth, { headers, id: created.id, pool: brokenPool, tenantId }),
      'the operation rejects when the revocation row cannot be written',
    ).rejects.toThrow();

    const rows = await revocationRows(tenantId, created.id);
    const verified = await api.verifyApiKey({
      body: { key: created.secret, configId: MACHINE_CREDENTIAL_CONFIG_ID },
    });
    expect(
      rows.length > 0 || verified.valid,
      'the credential is never disabled at the apiKey layer while absent from the revocation list',
    ).toBe(true);
  });
});
