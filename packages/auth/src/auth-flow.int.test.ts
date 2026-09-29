/**
 * Task 18.1 migration note (design D22): every fixture in this file that
 * used to call `auth.api.signUpEmail` now creates its user through
 * `./__fixtures__/admin-user.js`'s `createAdminUser` instead (the
 * admin-creation path, `auth.api.createUser`), since public self sign-up is
 * disabled (task 18.2). This changes only how each fixture's user account is
 * created, never the behavior any test below asserts.
 *
 * Integration test for task 2.3 (design D2, D13; Migration Plan step 1).
 * "Mount Better Auth's sign-up and sign-in behind `apps/api` (built in group
 * 11, stubbed here with an in-process handler call)."
 *
 * `apps/api` does not exist yet (group 11), so this test drives the
 * production `createAuth` instance (`./auth.js`, task 2.1) directly,
 * in-process, through `auth.api.signUpEmail`/`createOrganization`/
 * `signInEmail` — the same calling convention Better Auth's own
 * `getTestInstance` helper uses to exercise these endpoints without a real
 * HTTP request (verified against the installed `better-auth@1.7.6` source,
 * `dist/test-utils/test-instance.mjs`), and one of the two forms this task's
 * own text names ("`auth.handler(new Request(...))` or `auth.api.*`"). Once
 * `apps/api` mounts `auth.handler` at `/api/auth/*` (task 11.1), an HTTP-level
 * test takes over this same behavior; this cycle only needs the Better Auth
 * instance itself to behave correctly.
 *
 * This file covers exactly the two things task 2.3's Verify clause names:
 *
 * - The precondition of the later (task 12.2) scenario "Signing up creates a
 *   matching `_user` entity" (`specs/auth-and-rbac/spec.md`): "a new user
 *   signs up and joins an organization" — so a Better Auth `user` row and an
 *   `organization` row (with a `member` row joining them) exist. This test
 *   does **not** assert anything about a `_user` catalog entity: that upsert
 *   is task 12.2's own hook, wired through `@tayzu/catalog`, which this
 *   package does not depend on (design D1's acyclic package graph).
 * - "Sign in with the correct password succeeds": a user who has already
 *   signed up can sign in again with the same password and gets back a
 *   session token, independent of the two-factor plugin task 4.1 layers on
 *   top later (this cycle's user has no enrolled TOTP factor).
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `./auth.ts` (task 2.1) registers the `organization`/`admin`/`two-factor`/
 * `jwt`/`apiKey` plugins but never sets `emailAndPassword: { enabled: true }`.
 * Better Auth's own `/sign-up/email` and `/sign-in/email` routes both check
 * `ctx.context.options.emailAndPassword?.enabled` first and throw a
 * `BAD_REQUEST` (`EMAIL_PASSWORD_SIGN_UP_DISABLED`) / `EMAIL_PASSWORD_DISABLED`
 * `APIError` before doing anything else (verified against the installed
 * source, `dist/api/routes/sign-up.mjs`/`sign-in.mjs`) — so both tests below
 * fail on that thrown `APIError`, not on a missing export or a typo: this
 * package, `./auth.js` and `createAuth` all already exist (task 2.1).
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same shared-`DATABASE_URL`, `runMigrations`-then-`randomUUID()`-per-test
 * isolation pattern `packages/catalog/src/service/blueprints.int.test.ts`
 * (001) and `packages/db/src/schema.int.test.ts` (task 2.2) already
 * establish, adapted here because `@tayzu/auth`'s own tables have no
 * `tenant_id` column to key a fresh tenant off (design D6: "`tenant_id` =
 * `organization.id`", `organization` itself is the tenant); "a fresh random
 * tenant/org per test" instead means a freshly created `organization` row
 * (random `slug`) and a freshly signed-up `user` row (random `email`) per
 * test, so concurrent test files never collide on either unique constraint
 * (`user_email_uq`, `organization_slug_uq`, `packages/auth/src/persistence/
 * schema.ts`).
 *
 * The Drizzle handle passed to `createAuth`'s `db` option is built with
 * `drizzle(url, { schema: authSchema })`, not the bare `drizzle(url)` overload
 * `blueprints.int.test.ts` uses: `@better-auth/drizzle-adapter`'s own
 * `getSchema(model)` falls back to `db._.fullSchema` when
 * `drizzleAdapter`'s own `config.schema` option is not set (verified against
 * the installed `@better-auth/drizzle-adapter@1.7.6` source,
 * `dist/index.mjs`), and `./auth.ts` (task 2.1) never sets `config.schema`
 * either — so the adapter can only resolve a Better Auth model name (for
 * example `"user"`) to a real table object when the Drizzle instance itself
 * was constructed with that schema, exactly the way `apps/api` will build it
 * in task 11.1.
 *
 * Migrations are applied with `@tayzu/db`'s own `runMigrations(pool)`, the
 * same standard harness pattern every other int test file in this repo uses
 * (for example `packages/catalog/src/service/blueprints.int.test.ts`):
 * `packages/auth/package.json` now declares `@tayzu/db` as a dependency, so
 * this file builds its Drizzle handle exactly like `blueprint-test-
 * helpers.ts`'s own `connect`/`databaseUrl`/`endQuietly` trio does, then runs
 * migrations through `db.$client` (the underlying `pg.Pool`
 * `drizzle(url, { schema })` builds for a string `url`, `TClient` defaulting
 * to `Pool` — verified against the installed `drizzle-orm@0.45.3` source,
 * `drizzle-orm/node-postgres/driver.d.ts`) instead of a bare, unlocked
 * `drizzle-orm/node-postgres/migrator` call: `runMigrations` holds the same
 * session-level advisory lock every other int test file relies on to
 * serialize concurrent first-time appliers on a fresh database (design D12).
 */
import { randomUUID } from 'node:crypto';

import type { Attributes } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing here too (task 2.4; design D1;
// `packages/observability/CLAUDE.md`, "Import order"): the harness must
// register before `./auth.js`, which after task 2.4's green phase is
// expected to import a telemetry/instruments module that creates its
// tracer, meter and logger at import time -- exactly the rule
// `packages/catalog/src/service/pipeline.int.test.ts` documents for its own
// `./pipeline.js`. None of the imports above construct an OTel instrument.
import { createAdminUser } from './__fixtures__/admin-user.js';
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
import * as authSchema from './persistence/schema.js';
import { TEST_SECRET } from './__fixtures__/test-secret.js';

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

function randomEmail(): string {
  return `flow-${randomUUID()}@example.test`;
}

function randomSlug(): string {
  return `org-${randomUUID()}`;
}

/** A password long enough for Better Auth's default 8-character minimum. */
const TEST_PASSWORD = 'correct horse battery staple';

interface SignInEmailResult {
  readonly token: string | null;
  readonly user: { readonly id: string; readonly email: string };
}

interface CreateOrganizationResult {
  readonly id: string;
  readonly slug: string;
}

/**
 * The narrow slice of `auth.api` this file drives, typed locally: `./auth.ts`
 * (task 2.1) deliberately types `AuthInstance.api` as `unknown` (its own
 * comment: "callers introspect it by name"), the same pattern
 * `auth-instance.test.ts` already uses for its own, narrower per-plugin
 * assertions.
 */
interface AuthApiSurface {
  signInEmail(args: { body: { email: string; password: string } }): Promise<SignInEmailResult>;
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<CreateOrganizationResult>;
}

function apiOf(auth: AuthInstance): AuthApiSurface {
  return auth.api as AuthApiSurface;
}

// Type literals (not interfaces), so each satisfies `db.execute`'s
// `TRow extends Record<string, unknown>` constraint (TypeScript's implicit
// index signature applies to object type literals, not interfaces; see the
// same note in `packages/catalog/src/service/__fixtures__/
// blueprint-test-helpers.ts`).
type UserRow = {
  readonly id: string;
  readonly email: string;
};

type OrganizationRow = {
  readonly id: string;
  readonly slug: string;
};

type MemberRow = {
  readonly user_id: string;
  readonly organization_id: string;
  readonly role: string;
};

async function findUserByEmail(db: TestDb, email: string): Promise<UserRow | undefined> {
  const result = await db.execute<UserRow>(sql`
    select id, email from auth."user" where email = ${email}
  `);
  return result.rows[0];
}

async function findOrganizationById(
  db: TestDb,
  organizationId: string,
): Promise<OrganizationRow | undefined> {
  const result = await db.execute<OrganizationRow>(sql`
    select id, slug from auth.organization where id = ${organizationId}
  `);
  return result.rows[0];
}

async function findMember(
  db: TestDb,
  organizationId: string,
  userId: string,
): Promise<MemberRow | undefined> {
  const result = await db.execute<MemberRow>(sql`
    select user_id, organization_id, role
      from auth.member
     where organization_id = ${organizationId} and user_id = ${userId}
  `);
  return result.rows[0];
}

describe('Better Auth sign-up and sign-in behind apps/api (task 2.3, design D2, D13)', () => {
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

  it('the "Signing up creates a matching `_user` entity" precondition holds: an organization and a Better Auth user exist', async () => {
    const email = randomEmail();
    const slug = randomSlug();

    // Task 18.1 (design D22): no self-service sign-up left to exercise --
    // the admin-creation path (`auth.api.createUser`) is what now creates
    // the Better Auth `user` row this precondition needs.
    const adminUser = await createAdminUser(auth, {
      name: 'Flow Test User',
      email,
      password: TEST_PASSWORD,
    });

    expect(adminUser.email).toBe(email);

    const userRow = await findUserByEmail(db, email);
    expect(userRow, `a Better Auth "user" row exists for ${email}`).toBeDefined();
    expect(userRow?.id).toBe(adminUser.userId);

    // "... and joins an organization" (spec "Signing up creates a matching
    // `_user` entity"): the admin-created user is made a member of one.
    const organization = await api.createOrganization({
      body: { name: 'Flow Test Org', slug, userId: adminUser.userId },
    });

    expect(organization.slug).toBe(slug);

    const organizationRow = await findOrganizationById(db, organization.id);
    expect(
      organizationRow,
      `a Better Auth "organization" row exists for slug ${slug}`,
    ).toBeDefined();
    expect(organizationRow?.slug).toBe(slug);

    const memberRow = await findMember(db, organization.id, adminUser.userId);
    expect(
      memberRow,
      'a Better Auth "member" row joins the admin-created user to the organization',
    ).toBeDefined();
  });

  it('Sign in with the correct password succeeds', async () => {
    const email = randomEmail();
    await createAdminUser(auth, { name: 'Flow Test User', email, password: TEST_PASSWORD });

    const signIn = await api.signInEmail({
      body: { email, password: TEST_PASSWORD },
    });

    expect(signIn.token).toBeTypeOf('string');
    expect(signIn.token).not.toBe('');
    expect(signIn.user.email).toBe(email);
  });
});

/**
 * Integration tests for task 2.4 (design D2, D3, D19; design.md,
 * "Observability contract" -> Metrics table row `tayzu.auth.session.events`
 * and Log events table rows `auth.security.login_succeeded`/
 * `auth.security.login_failed`).
 *
 * "Wire `auth.security.login_succeeded`/`login_failed` log events and the
 * `tayzu.auth.session.events` counter on sign-in."
 *
 * ## Tenant resolution on sign-in (orchestrator decision, resumed task 2.4)
 *
 * The design leaves how `session.activeOrganizationId` gets set on sign-in
 * unstated beyond D3's "few known tenants, no org switcher before 042"
 * framing. Resolved: when a session is created, if the signing-in user
 * belongs to exactly one organization, the session's `activeOrganizationId`
 * is set to it; otherwise it stays `null`. So for a user with exactly one
 * membership, `auth.security.login_succeeded` carries `tayzu.tenant.id` =
 * that organization's id and `tayzu.actor.id` = the user's id, and the
 * session row's `active_organization_id` column equals the same
 * organization id (asserted directly against `auth.session`, the same table
 * `findSessionByToken` below queries). A user with zero memberships is out
 * of scope here (task 2.4's Verify clause and the orchestrator's own
 * instructions do not name it); only the exactly-one-membership case is
 * covered.
 *
 * `bad_credentials` is the sole failure reason exercised here (wrong
 * password AND unknown email emit the identical `auth.security.login_failed`
 * signal, matching Better Auth's own enumeration-resistant
 * `INVALID_EMAIL_OR_PASSWORD` `APIError`, thrown identically for both cases
 * by the installed `better-auth@1.7.6` source,
 * `dist/api/routes/sign-in.mjs`). `mfa_failed` and `account_disabled` belong
 * to later tasks (4.x) and are not exercised here.
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `./auth.ts` (task 2.1/2.3) never wires any telemetry: it emits no
 * `auth.security.login_succeeded`/`login_failed` log record and no
 * `tayzu.auth.session.events` counter increment on sign-in, and nothing sets
 * `session.activeOrganizationId` for a single-membership user either. Every
 * test below therefore fails on an assertion (an empty captured-log-records
 * array, or an empty captured-counter-data-points array, or a `null`
 * `active_organization_id`), not on a missing export or a typo: `./auth.js`,
 * `createAuth` and every table this file queries already exist (tasks
 * 2.1-2.3).
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same shared-`DATABASE_URL` / `runMigrations`-then-`randomUUID()`-per-test
 * isolation pattern as the describe block above (task 2.3), and the same
 * `drizzle(url, { schema: authSchema })` handle for the same
 * `@better-auth/drizzle-adapter` model-resolution reason documented there.
 * This describe block opens its own connection and its own `createAuth`
 * instance rather than reusing the one above's `describe`-scoped variables,
 * because those are private to that `describe` callback's closure.
 *
 * The telemetry harness is registered by `./__fixtures__/registered-harness.js`,
 * imported before `./auth.js` at the top of this file (import order is
 * load-bearing; see that fixture's own doc comment and the comment on this
 * file's import block). Each test below calls `harness.reset()` immediately
 * before the sign-in call under test, discarding whatever sign-up/
 * organization-creation setup emitted, so `finishedLogRecords`/
 * `sumDataPoints` below only ever see the one action each test cares about.
 */
describe('Sign-in telemetry: login_succeeded / login_failed (task 2.4, design D2/D3/D19)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let api: AuthApiSurface;
  let harness: TelemetryTestHarness;

  /** The harness `./__fixtures__/registered-harness.js` registered while the module graph loaded. */
  function registeredHarness(): TelemetryTestHarness {
    if ('error' in registration) {
      throw new Error(
        `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
        { cause: registration.error },
      );
    }
    return registration.harness;
  }

  type LogExporterLike = TelemetryTestHarness['logExporter'];
  type ReadableLogRecordLike = ReturnType<LogExporterLike['getFinishedLogRecords']>[number];
  type MetricExporterLike = TelemetryTestHarness['metricExporter'];

  function finishedLogRecords(
    exporter: LogExporterLike,
    eventName: string,
  ): ReadableLogRecordLike[] {
    return [...exporter.getFinishedLogRecords()].filter((record) => record.eventName === eventName);
  }

  /**
   * `@opentelemetry/sdk-metrics`'s `DataPointType.SUM` value, inlined rather
   * than imported: `@tayzu/auth` does not declare `@opentelemetry/sdk-metrics`
   * as its own dependency (only `@tayzu/observability` does), and this enum
   * is part of the exporter's own stable, JSON-serializable data shape
   * (same rationale as `packages/catalog/src/service/pipeline.int.test.ts`'s
   * identical constant).
   */
  const METRIC_DATA_POINT_TYPE_SUM = 3;

  interface CapturedSumPoint {
    readonly attributes: Attributes;
    readonly value: number;
  }

  /** Every SUM (counter) data point of `name`, across every export the exporter holds. */
  function sumDataPoints(exporter: MetricExporterLike, name: string): CapturedSumPoint[] {
    const points: CapturedSumPoint[] = [];
    for (const resourceMetrics of exporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (
            metric.descriptor.name === name &&
            // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
            metric.dataPointType === METRIC_DATA_POINT_TYPE_SUM
          ) {
            for (const dataPoint of metric.dataPoints) {
              points.push({ attributes: dataPoint.attributes, value: dataPoint.value });
            }
          }
        }
      }
    }
    return points;
  }

  /**
   * A minimal, JSON-serializable snapshot of everything the harness has
   * captured so far: every finished log record's `attributes`/`body`, and
   * every finished metric data point's `attributes`. Deliberately narrower
   * than serializing the exporters' raw finished-record objects directly
   * (which carry resource/instrumentation-scope references and are not
   * guaranteed acyclic) -- same rationale as the marker-leak sweep in
   * `packages/catalog/src/service/pipeline.int.test.ts`.
   */
  function serializedTelemetrySnapshot(): string {
    const logs = [...harness.logExporter.getFinishedLogRecords()].map((record) => ({
      attributes: record.attributes,
      body: record.body,
    }));
    const metricAttributes: Attributes[] = [];
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          for (const dataPoint of metric.dataPoints) {
            metricAttributes.push(dataPoint.attributes);
          }
        }
      }
    }
    return JSON.stringify({ logs, metricAttributes });
  }

  /**
   * Asserts that none of `secrets` (an email, a password, a name -- anything
   * that must never reach telemetry, per root `CLAUDE.md`, "No tenant free
   * text in telemetry or errors") appears anywhere in what the harness has
   * captured so far.
   */
  function expectNoSecretsInTelemetry(secrets: readonly string[]): void {
    const snapshot = serializedTelemetrySnapshot();
    for (const secret of secrets) {
      expect(snapshot, `telemetry must never contain ${JSON.stringify(secret)}`).not.toContain(
        secret,
      );
    }
  }

  type SessionRow = {
    readonly user_id: string;
    readonly active_organization_id: string | null;
  };

  async function findSessionByToken(db: TestDb, token: string): Promise<SessionRow | undefined> {
    const result = await db.execute<SessionRow>(sql`
      select user_id, active_organization_id from auth.session where token = ${token}
    `);
    return result.rows[0];
  }

  const SIGN_IN_TELEMETRY_TEST_NAME = 'Sign-in Telemetry Test User';
  const WRONG_PASSWORD = 'definitely the wrong password, not correct';

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    api = apiOf(auth);
    harness = registeredHarness();
  }, 60_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  it('Sign in with the correct password, as a user with exactly one organization membership, emits exactly one login_succeeded log at INFO and increments the session-events counter', async () => {
    const email = randomEmail();
    const slug = randomSlug();
    const adminUser = await createAdminUser(auth, {
      name: SIGN_IN_TELEMETRY_TEST_NAME,
      email,
      password: TEST_PASSWORD,
    });
    const organization = await api.createOrganization({
      body: { name: 'Sign-in Telemetry Test Org', slug, userId: adminUser.userId },
    });

    // Discard whatever sign-up/organization-creation emitted: only the
    // sign-in call below is under test.
    await harness.reset();

    const signIn = await api.signInEmail({
      body: { email, password: TEST_PASSWORD },
    });

    await harness.forceFlush();

    const logs = finishedLogRecords(harness.logExporter, 'auth.security.login_succeeded');
    expect(logs, 'exactly one login_succeeded log record').toHaveLength(1);
    const record = logs[0];
    expect(record?.severityNumber).toBe(SeverityNumber.INFO);
    expect(record?.attributes).toEqual({
      'tayzu.tenant.id': organization.id,
      'tayzu.actor.id': adminUser.userId,
    });

    const points = sumDataPoints(harness.metricExporter, 'tayzu.auth.session.events').filter(
      (point) => point.attributes['tayzu.auth.event'] === 'login_succeeded',
    );
    expect(points, 'the session-events counter incremented once for login_succeeded').toHaveLength(
      1,
    );
    expect(points[0]?.value).toBe(1);
    expect(points[0]?.attributes).toEqual({ 'tayzu.auth.event': 'login_succeeded' });

    // The session's activeOrganizationId is the login_succeeded log's own
    // tayzu.tenant.id, per the orchestrator's resolved decision above.
    const sessionRow = await findSessionByToken(db, String(signIn.token));
    expect(
      sessionRow?.active_organization_id,
      "the session row's active_organization_id equals the sole organization the user belongs to",
    ).toBe(organization.id);

    expectNoSecretsInTelemetry([email, TEST_PASSWORD, SIGN_IN_TELEMETRY_TEST_NAME]);
  });

  it('Sign in with the wrong password emits exactly one login_failed log at WARN with failure_reason bad_credentials and increments the session-events counter', async () => {
    const email = randomEmail();
    await createAdminUser(auth, {
      name: SIGN_IN_TELEMETRY_TEST_NAME,
      email,
      password: TEST_PASSWORD,
    });

    await harness.reset();

    await expect(api.signInEmail({ body: { email, password: WRONG_PASSWORD } })).rejects.toThrow();

    await harness.forceFlush();

    const logs = finishedLogRecords(harness.logExporter, 'auth.security.login_failed');
    expect(logs, 'exactly one login_failed log record').toHaveLength(1);
    const record = logs[0];
    expect(record?.severityNumber).toBe(SeverityNumber.WARN);
    expect(record?.attributes).toEqual({ 'tayzu.auth.failure_reason': 'bad_credentials' });

    const points = sumDataPoints(harness.metricExporter, 'tayzu.auth.session.events').filter(
      (point) => point.attributes['tayzu.auth.event'] === 'login_failed',
    );
    expect(points, 'the session-events counter incremented once for login_failed').toHaveLength(1);
    expect(points[0]?.value).toBe(1);
    expect(points[0]?.attributes).toEqual({ 'tayzu.auth.event': 'login_failed' });

    expectNoSecretsInTelemetry([email, TEST_PASSWORD, WRONG_PASSWORD, SIGN_IN_TELEMETRY_TEST_NAME]);
  });

  it('Sign in for an unknown email emits exactly one login_failed log at WARN with the same failure_reason bad_credentials (no enumeration) and increments the session-events counter', async () => {
    const email = randomEmail();

    await harness.reset();

    await expect(api.signInEmail({ body: { email, password: TEST_PASSWORD } })).rejects.toThrow();

    await harness.forceFlush();

    const logs = finishedLogRecords(harness.logExporter, 'auth.security.login_failed');
    expect(logs, 'exactly one login_failed log record').toHaveLength(1);
    const record = logs[0];
    expect(record?.severityNumber).toBe(SeverityNumber.WARN);
    expect(record?.attributes).toEqual({ 'tayzu.auth.failure_reason': 'bad_credentials' });

    const points = sumDataPoints(harness.metricExporter, 'tayzu.auth.session.events').filter(
      (point) => point.attributes['tayzu.auth.event'] === 'login_failed',
    );
    expect(points, 'the session-events counter incremented once for login_failed').toHaveLength(1);
    expect(points[0]?.value).toBe(1);
    expect(points[0]?.attributes).toEqual({ 'tayzu.auth.event': 'login_failed' });

    expectNoSecretsInTelemetry([email, TEST_PASSWORD]);
  });
});
