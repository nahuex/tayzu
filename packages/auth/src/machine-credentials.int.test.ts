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

import { runMigrations } from '@tayzu/db';
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

interface AuthApiSurface {
  getApiKey(args: {
    query: { readonly id: string; readonly configId?: string };
    headers: Headers;
  }): Promise<GetApiKeyResult>;
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
});
