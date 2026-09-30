/**
 * Integration test for task 4.2 (design D4; `specs/auth-and-rbac/spec.md`,
 * "Step-up authentication for high-risk operations").
 *
 * "A step-up guard reading `x-tayzu-risk: high` off the invoked procedure's
 * route and a `twoFactorVerifiedAt` freshness check (5-minute threshold),
 * applied only to `user` actors." This file covers exactly the three
 * scenarios task 4.2's own Verify clause names, quoted from
 * `specs/auth-and-rbac/spec.md`:
 *
 * #### Scenario: High-risk operation without a fresh MFA verification is blocked
 * - GIVEN a user signed in without verifying MFA in the last 5 minutes
 * - WHEN they call `blueprints.delete`
 * - THEN it fails with `AUTH_STEP_UP_REQUIRED` and the blueprint is not deleted
 *
 * #### Scenario: High-risk operation with a fresh MFA verification succeeds
 * - GIVEN a user verified an MFA factor 1 minute ago
 * - WHEN they call `blueprints.delete` on an otherwise-deletable blueprint
 * - THEN the deletion proceeds
 *
 * #### Scenario: High-risk operation by an integration actor is not gated by step-up
 * - GIVEN an `integration` actor authorized by Cerbos to delete a blueprint
 * - WHEN it calls `blueprints.delete`
 * - THEN the deletion proceeds without any step-up check
 *
 * plus task 4.2's own "the `auth.security.step_up_required` log event and
 * `tayzu.auth.step_up.required` counter on the blocked case" (design.md,
 * "Observability contract" -> Log events table: `auth.security.
 * step_up_required`, WARN, `tayzu.tenant.id`, `tayzu.actor.id`,
 * `tayzu.catalog.operation`; Metrics table: `tayzu.auth.step_up.required`,
 * Counter `{event}`, attribute `tayzu.catalog.operation`).
 *
 * **Telemetry fix-up** (`observability-auditor` BLOCK on this task):
 * design.md's Spans table also declares `auth.session.step_up_check` ("any
 * `x-tayzu-risk: high` operation invoked by a `user` actor", required
 * attribute `tayzu.auth.method` (`local`\|`visma_connect`), conditional
 * attribute `tayzu.auth.step_up.fresh` (bool)) -- unconditional on every
 * guard invocation for a `user` actor on a high-risk route, independent of
 * whether the guard blocks or allows the operation through, unlike the
 * blocked-only log/counter above. `./step-up.ts` currently never starts this
 * span at all (confirmed by reading the whole file: no `tracer.startSpan`
 * call anywhere in it). The first two scenarios below (the only two that
 * invoke the guard as a `user` actor) are extended to assert it, once on the
 * blocked path (`tayzu.auth.step_up.fresh: false`) and once on the fresh
 * path (`tayzu.auth.step_up.fresh: true`); the third (`integration` actor)
 * scenario is extended to assert the span is *not* emitted, since design.md's
 * own "invoked by a `user` actor" scope excludes it, matching the guard's own
 * existing early return for non-`user` actors. `tayzu.auth.method` is
 * asserted as `'local'` in both user-actor cases: no session in this package
 * yet carries a Visma Connect-established marker (`ssoSid`, design D25, task
 * 21.2, not implemented -- confirmed by reading `./persistence/schema.ts`),
 * so `'local'` is the only value design.md's closed two-value enum permits
 * here today. No client id, secret, or token appears in any signal this file
 * asserts on (none of that data exists on this guard's own inputs/outputs in
 * the first place -- `AssertStepUpParams` carries `headers`/`tenantId`/
 * `actor`/`route`/`operation` only, none of it a credential).
 *
 * The requirement text above the scenarios (same spec section) is the source
 * for the human-only scope: "This requirement applies only to human (`user`)
 * callers; `agent`, `integration`, and `system` actors are governed by Cerbos
 * policy alone." Design D4 names the exact mechanism: "every procedure whose
 * `route.spec` carries `x-tayzu-risk: high` is wrapped so that, for a `user`
 * actor only, the guard calls `auth.api.verifyTwoFactor`'s underlying
 * freshness check (a `twoFactorVerifiedAt` timestamp stored on the session,
 * updated whenever `/two-factor/verify` succeeds) and rejects with
 * `AUTH_STEP_UP_REQUIRED` if older than 5 minutes or absent." Spec
 * "Conventions": "Step-up freshness: an MFA verification is 'fresh' for 5
 * minutes," and the new error code "`AUTH_STEP_UP_REQUIRED` (403, the action
 * needs a fresh MFA verification)."
 *
 * ## Module under test, and why its shape is this file's own design decision
 *
 * No file named `step-up.ts` (or anything similar) exists anywhere in
 * `packages/auth/src` yet (confirmed by listing the directory before writing
 * this file) -- task 4.2 is genuinely new production code, not an extension
 * of an existing module. Design D4 describes *behavior* ("every procedure
 * whose `route.spec` carries `x-tayzu-risk: high` is wrapped...") but names
 * no concrete function signature, and `packages/auth/package.json` declares
 * no dependency on `@orpc/*` or `@tayzu/catalog` (confirmed by reading it),
 * so the guard this task adds cannot literally receive a real oRPC procedure
 * or a real `@tayzu/catalog` route object -- that cross-package wiring is a
 * later task's job (group 9's Cerbos pipeline stage, or group 11's `apps/api`
 * bootstrap, neither of which exists yet either). This file therefore assumes
 * a package-local, framework-agnostic shape for the guard, `./step-up.ts`
 * exporting:
 *
 * - `createStepUpGuard({ auth })`, the same `create*({ auth })` factory
 *   convention `./context-resolver.ts`'s own `createContextResolver({ auth
 *   })` already establishes, returning a `StepUpGuard` function.
 * - `StepUpGuard = (params: AssertStepUpParams) => Promise<void>`: resolves
 *   when the operation may proceed, rejects with a `{ code:
 *   'AUTH_STEP_UP_REQUIRED' }`-shaped error otherwise -- the same
 *   structural-error-shape convention `./errors.ts`'s own `AuthContextError`
 *   (`{ code: 'CATALOG_CONTEXT_REQUIRED' }`) already establishes for this
 *   package, asserted against here the same way
 *   `context-resolver.int.test.ts`'s own `expectContextRequiredRejection`
 *   asserts `AuthContextError` structurally, without importing the class.
 * - `AssertStepUpParams`: `headers` (a real `Headers`, so the guard can read
 *   the caller's actual current session through `auth.api.getSession`, the
 *   same primitive `./context-resolver.ts` already uses, rather than trusting
 *   a caller-supplied timestamp); `tenantId` and `actor: { type, id }` (the
 *   same two fields a `CatalogContext` already carries at the point a future
 *   pipeline integration would call this guard, immediately after context
 *   resolution and before the operation itself runs -- design D4's own
 *   ordering); `route: { riskLevel?: 'high' }` (a already-evaluated stand-in
 *   for "the invoked procedure's route carries `x-tayzu-risk: high`" -- the
 *   real OpenAPI `x-tayzu-risk` marker lives in `@tayzu/catalog`'s oRPC
 *   contract, `packages/catalog/src/api/contract.ts`'s own `markHighRisk`,
 *   which this package cannot import); and `operation` (a plain string,
 *   `tayzu.catalog.operation`'s value on the blocked-case telemetry below).
 *
 * Flagged here, per this assignment's own instructions, in case task 4.2's
 * green phase settles on a different shape -- the scenario coverage below
 * does not depend on which concrete shape wins, only the `createStepUpGuard`/
 * `guard(params)` call sites would need to change.
 *
 * ## Why a spied handler stands in for "the blueprint is not deleted" / "the deletion proceeds"
 *
 * Since `@tayzu/auth` cannot import `@tayzu/catalog`'s real
 * `blueprints.delete` operation (see above), each scenario below wraps the
 * guard call with a local callback representing "the guarded operation's own
 * handler" -- called only if the guard resolves. The first scenario's "the
 * blueprint is not deleted" becomes "the handler representing the deletion
 * never runs"; the second and third scenarios' "the deletion proceeds"
 * becomes "the handler runs exactly once." `operation` is passed through as
 * the plain string `'blueprint.delete'` -- the actual `name` value
 * `packages/catalog/src/service/blueprints.ts`'s own `defineCatalogOperation`
 * call already uses for this operation (singular, not the oRPC router's own
 * plural `blueprints.delete` path segment, `packages/catalog/src/api/
 * router.ts`) -- since that is the value design.md's own `tayzu.catalog.
 * operation` attribute already carries in production
 * (`packages/catalog/src/service/pipeline.ts`'s `OPERATION_ATTRIBUTE`), and
 * this file's own telemetry assertions below check that exact attribute.
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `./step-up.js` does not exist (confirmed above), so every test below fails
 * at import time with a "Cannot find module" error -- exactly the one
 * acceptable missing-module condition this assignment's own instructions
 * name ("acceptable only for the module under test"). Every other import in
 * this file (`./auth.js`, `./persistence/schema.js`,
 * `./__fixtures__/registered-harness.js`, `@tayzu/db`) already exists and is
 * exercised unchanged by every other int test file in this package (for
 * example `mfa.int.test.ts`'s own TOTP-enrollment helpers, duplicated locally
 * below since test files do not export helpers to one another).
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same shared-`DATABASE_URL` / `runMigrations`-per-suite,
 * `randomUUID()`-per-test isolation pattern as every other int test file in
 * this package. "GIVEN a user signed in without verifying MFA in the last 5
 * minutes" is realized as a user with *no* enrolled MFA factor at all (a
 * plain sign-up/sign-in, `mfa.int.test.ts`'s own "Unenrolled user" scenario)
 * -- trivially true that such a user has no MFA verification in the last 5
 * minutes, since they have never verified one. "GIVEN a user verified an MFA
 * factor 1 minute ago" is realized as a real, just-completed TOTP
 * verification (enrollment via the sign-up session, then a fresh sign-in's
 * 2FA challenge completed by `POST /two-factor/verify-totp` through
 * `auth.handler`, the same enrollment sequence `mfa.int.test.ts`'s own
 * `enrollTotp` establishes, extended here with the sign-in-challenge
 * completion step needed to reach a *fresh*, real `twoFactorVerifiedAt`) --
 * a verification that just happened is comfortably within the 5-minute
 * freshness window design.md's Conventions section defines, satisfying the
 * scenario's intent (a *fresh* verification) without depending on exactly
 * which underlying column or table task 4.2's green phase stores
 * `twoFactorVerifiedAt` in (this file only ever reads it indirectly, through
 * the guard itself, never by direct SQL). `verify-totp`, not `auth.api.
 * verifyTOTP` directly, is used for that last step because only the real
 * HTTP entry point (`auth.handler(new Request(...))`) returns a `Set-Cookie`
 * header for the session `setSessionCookie` creates on this path (verified
 * against the installed `better-auth@1.7.6` source,
 * `dist/plugins/two-factor/totp/index.mjs`: the sign-in-challenge branch
 * creates a brand new session and calls `setSessionCookie`, unlike the
 * enrollment branch `mfa.int.test.ts`'s own `enrollTotp` drives through
 * `auth.api.verifyTOTP`, which needs no fresh cookie back). Every request
 * carries its own fresh, random `x-forwarded-for` IP (`randomIp()`), per this
 * task's own instructions, so no rate limiter interferes.
 *
 * The telemetry harness (`./__fixtures__/registered-harness.js`, imported
 * before `./auth.js` for the load-bearing reason every other int test file in
 * this package documents) is reset before each guard call under test, and
 * asserted with the same `finishedLogRecords`/`sumDataPoints` helpers
 * `auth-flow.int.test.ts`'s own task-2.4 describe block already establishes,
 * duplicated locally for the same "test files do not export to one another"
 * reason as the TOTP helpers.
 */
import { randomInt, randomUUID } from 'node:crypto';

import type { Attributes } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Import order is load-bearing (task 2.4; design D1; `packages/observability/
// CLAUDE.md`, "Import order"): the harness must register before `./auth.js`,
// which imports a telemetry/instruments module that creates its tracer,
// meter and logger at import time. Same rationale as every other int test
// file in this package.
import { bootstrapTestTenant } from './__fixtures__/admin-user.js';
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
// The module under test (task 4.2): does not exist yet (see this file's own
// module doc comment, "Module under test, and why its shape is this file's
// own design decision").
import { createStepUpGuard } from './step-up.js';
import type { AssertStepUpParams, StepUpGuard } from './step-up.js';
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

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function randomEmail(): string {
  return `step-up-${randomUUID()}@example.test`;
}

function randomSlug(): string {
  return `step-up-org-${randomUUID()}`;
}

/** A password long enough for Better Auth's default 8-character minimum. */
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_USER_NAME = 'Step-Up Test User';

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';

/** The origin this test's `createAuth` trusts; a browser sends it as `Origin` on cookie-bearing POSTs (Q40). */
const TRUSTED_ORIGIN = 'http://localhost:3000';

/**
 * `./auth.ts`'s `AuthInstance.api` is typed `unknown`; `.handler` is Better
 * Auth's real, documented HTTP entry point -- same cast every other int test
 * file in this package already uses (for example `mfa.int.test.ts`'s own
 * `handlerOf`).
 */
function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

function postJson(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: Record<string, unknown>,
  ip: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  return handler(
    new Request(`${AUTH_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * A real `cookie` header value built from a Better Auth HTTP response's own
 * `Set-Cookie` header(s) -- same helper as every other int test file in this
 * package (for example `mfa.int.test.ts`'s own `cookieHeaderFrom`).
 */
function cookieHeaderFrom(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length === 0) {
    throw new Error('expected response to carry at least one Set-Cookie header');
  }
  return setCookies.map((raw) => raw.split(';')[0]).join('; ');
}

interface VerifyTotpResponseBody {
  readonly token: string;
  readonly user: { readonly id: string };
}

interface CreateOrganizationResult {
  readonly id: string;
  readonly slug: string;
}

/**
 * The narrow slice of `auth.api` this file drives in-process (organization
 * creation, plus the server-only TOTP-code helper and the session-
 * authenticated TOTP enrollment endpoints), typed locally the same
 * "introspect the narrower production type locally" pattern every other int
 * test file in this package already uses.
 */
interface AuthApiSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<CreateOrganizationResult>;
  enableTwoFactor(args: {
    body: { password: string; method: 'totp' };
    headers: Headers;
  }): Promise<{ method: 'totp'; totpURI: string; backupCodes: readonly string[] }>;
  generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
  verifyTOTP(args: {
    body: { code: string };
    headers: Headers;
  }): Promise<{ token: string | null; user: { id: string } }>;
}

function apiOf(auth: AuthInstance): AuthApiSurface {
  return auth.api as AuthApiSurface;
}

/**
 * A minimal RFC 4648 Base32 decoder (no padding), matching the alphabet and
 * bit-packing `@better-auth/utils@0.4.2`'s own `dist/base32.mjs` uses to
 * *encode* a TOTP secret into `totpURI`'s `secret` query parameter --
 * duplicated locally from `mfa.int.test.ts`'s own identical helper (test
 * files do not export to one another), whose own module doc comment explains
 * the full derivation in detail.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(encoded: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bitsCollected = 0;
  for (const char of encoded) {
    if (char === '=') {
      break;
    }
    const value = BASE32_ALPHABET.indexOf(char.toUpperCase());
    if (value === -1) {
      throw new Error(`invalid base32 character in TOTP secret: ${char}`);
    }
    buffer = (buffer << 5) | value;
    bitsCollected += 5;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      bytes.push((buffer >> bitsCollected) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** Recovers the raw TOTP secret Better Auth used for HMAC from `totpURI`'s Base32-encoded `secret` query parameter. */
function rawSecretFromTotpUri(totpURI: string): string {
  const secretParam = new URL(totpURI).searchParams.get('secret');
  if (secretParam === null) {
    throw new Error('expected a secret query parameter on the TOTP URI');
  }
  return new TextDecoder().decode(decodeBase32(secretParam));
}

/** design.md, "Observability contract" -> "the invoked procedure's route": task 4.2's own high-risk marker stand-in. */
const HIGH_RISK_ROUTE = { riskLevel: 'high' } as const;

/**
 * The exact `name` value `packages/catalog/src/service/blueprints.ts`'s own
 * `defineCatalogOperation` call already uses for this operation (see this
 * file's own module doc comment for why this, not the oRPC router's plural
 * `blueprints.delete` path segment).
 */
const BLUEPRINT_DELETE_OPERATION = 'blueprint.delete';

describe('Step-up guard for high-risk operations (task 4.2, design D4)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let api: AuthApiSurface;
  let guard: StepUpGuard;
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
   * than imported -- same rationale, and the same value, as `auth-flow.int.
   * test.ts`'s own identical constant.
   */
  const METRIC_DATA_POINT_TYPE_SUM = 3;

  interface CapturedSumPoint {
    readonly attributes: Attributes;
    readonly value: number;
  }

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

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET, trustedOrigins: [TRUSTED_ORIGIN] });
    api = apiOf(auth);
    guard = createStepUpGuard({ auth });
    harness = registeredHarness();
  }, 60_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  /**
   * "GIVEN a user signed in without verifying MFA in the last 5 minutes":
   * realized as a user with no enrolled MFA factor at all, signed in
   * normally -- trivially satisfies the GIVEN clause (see this file's own
   * module doc comment). Task 18.1 (design D22): provisioned through the
   * admin-creation path (`./__fixtures__/admin-user.js`'s
   * `bootstrapTestTenant`) instead of Better Auth's own `/sign-up/email`
   * route -- since the created user's one organization membership already
   * exists before `bootstrapTestTenant`'s own, single sign-in call, that
   * session already carries an `activeOrganizationId` (task 2.4's
   * exactly-one-membership rule).
   */
  async function signUpSignedInWithOrg(): Promise<{
    readonly cookie: string;
    readonly userId: string;
    readonly organizationId: string;
  }> {
    const tenant = await bootstrapTestTenant(auth, {
      name: TEST_USER_NAME,
      email: randomEmail(),
      password: TEST_PASSWORD,
      organizationName: 'Step-Up Test Org',
      organizationSlug: randomSlug(),
      ip: randomIp(),
    });

    return {
      cookie: tenant.cookie,
      userId: tenant.userId,
      organizationId: tenant.organizationId,
    };
  }

  /**
   * "GIVEN a user verified an MFA factor 1 minute ago": enrolls TOTP over the
   * sign-up session (same enrollment sequence as `mfa.int.test.ts`'s own
   * `enrollTotp`), then drives a real sign-in's 2FA challenge to completion
   * through `POST /two-factor/verify-totp`, returning the *freshly created*
   * post-verification session's own cookie -- see this file's own module doc
   * comment for why this, not the enrollment session itself, is what each
   * scenario's guard call below is checked against.
   */
  async function signUpWithFreshMfaVerification(): Promise<{
    readonly cookie: string;
    readonly userId: string;
    readonly organizationId: string;
  }> {
    const handler = handlerOf(auth);
    const email = randomEmail();

    // Task 18.1 (design D22): provisioned through the admin-creation path
    // (`./__fixtures__/admin-user.js`) instead of Better Auth's own
    // `/sign-up/email` route -- see `signUpSignedInWithOrg`'s own comment
    // above for why `bootstrapTestTenant`'s single sign-in already carries
    // an `activeOrganizationId`.
    const tenant = await bootstrapTestTenant(auth, {
      name: TEST_USER_NAME,
      email,
      password: TEST_PASSWORD,
      organizationName: 'Step-Up Test Org',
      organizationSlug: randomSlug(),
      ip: randomIp(),
    });

    // Enroll TOTP over that first session (enrollment does not itself need
    // to be fresh; only the later sign-in verification does).
    const enabled = await api.enableTwoFactor({
      body: { password: TEST_PASSWORD, method: 'totp' },
      headers: new Headers({ cookie: tenant.cookie }),
    });
    const secret = rawSecretFromTotpUri(enabled.totpURI);
    const enrollCode = (await api.generateTOTP({ body: { secret } })).code;
    await api.verifyTOTP({
      body: { code: enrollCode },
      headers: new Headers({ cookie: tenant.cookie }),
    });

    // A fresh sign-in now challenges for the enrolled TOTP factor.
    const challengeResponse = await postJson(
      handler,
      '/sign-in/email',
      { email, password: TEST_PASSWORD },
      randomIp(),
    );
    expect(challengeResponse.status, 'the sign-in itself is not rejected outright').toBe(200);
    const challengeCookie = cookieHeaderFrom(challengeResponse);

    // Completing the challenge with a currently-valid TOTP code creates a
    // brand new, fully signed-in session -- "verified... 1 minute ago",
    // realized here as verified moments ago, comfortably within the 5-minute
    // freshness window (see this file's own module doc comment).
    const verifyCode = (await api.generateTOTP({ body: { secret } })).code;
    const verifyResponse = await postJson(
      handler,
      '/two-factor/verify-totp',
      { code: verifyCode },
      randomIp(),
      { cookie: challengeCookie, origin: TRUSTED_ORIGIN },
    );
    expect(verifyResponse.status, 'the TOTP challenge is verified').toBe(200);
    const verified = (await verifyResponse.json()) as VerifyTotpResponseBody;
    expect(verified.user.id).toBe(tenant.userId);

    return {
      cookie: cookieHeaderFrom(verifyResponse),
      userId: tenant.userId,
      organizationId: tenant.organizationId,
    };
  }

  /**
   * Runs the guard, then a stand-in for the guarded operation's own handler
   * (see this file's own module doc comment, "Why a spied handler stands in
   * for..."). Returns the handler spy so each test can assert whether it ran.
   */
  async function invokeGuarded(
    params: AssertStepUpParams,
  ): Promise<{ readonly handler: ReturnType<typeof vi.fn> }> {
    const handler = vi.fn();
    await guard(params);
    handler();
    return { handler };
  }

  it('High-risk operation without a fresh MFA verification is blocked', async () => {
    const user = await signUpSignedInWithOrg();

    await harness.reset();

    const params: AssertStepUpParams = {
      headers: new Headers({ cookie: user.cookie }),
      tenantId: user.organizationId,
      actor: { type: 'user', id: user.userId },
      route: HIGH_RISK_ROUTE,
      operation: BLUEPRINT_DELETE_OPERATION,
    };

    // WHEN "they call `blueprints.delete`". THEN "it fails with
    // `AUTH_STEP_UP_REQUIRED` and the blueprint is not deleted": the guard
    // itself rejects, and (see `invokeGuarded`) the stand-in handler
    // representing the deletion never runs.
    const handler = vi.fn();
    await expect(
      (async () => {
        await guard(params);
        handler();
      })(),
    ).rejects.toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' });
    expect(handler, 'the deletion handler never runs').not.toHaveBeenCalled();

    await harness.forceFlush();

    // AND "the `auth.security.step_up_required` log event and
    // `tayzu.auth.step_up.required` counter on the blocked case".
    const logs = finishedLogRecords(harness.logExporter, 'auth.security.step_up_required');
    expect(logs, 'exactly one step_up_required log record').toHaveLength(1);
    expect(logs[0]?.severityNumber).toBe(SeverityNumber.WARN);
    expect(logs[0]?.attributes).toEqual({
      'tayzu.tenant.id': user.organizationId,
      'tayzu.actor.id': user.userId,
      'tayzu.catalog.operation': BLUEPRINT_DELETE_OPERATION,
    });

    const points = sumDataPoints(harness.metricExporter, 'tayzu.auth.step_up.required');
    expect(points, 'the step-up-required counter incremented once').toHaveLength(1);
    expect(points[0]?.value).toBe(1);
    expect(points[0]?.attributes).toEqual({
      'tayzu.catalog.operation': BLUEPRINT_DELETE_OPERATION,
    });

    // Telemetry fix-up (design.md, Spans table: `auth.session.step_up_check`,
    // "any `x-tayzu-risk: high` operation invoked by a `user` actor" --
    // unconditional on this guard invocation, blocked or not): required
    // attribute `tayzu.auth.method` (`'local'`, see this file's own module
    // doc comment for why); conditional attribute `tayzu.auth.step_up.fresh`,
    // `false` on this blocked path.
    const stepUpCheckSpans = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.name === 'auth.session.step_up_check');
    expect(
      stepUpCheckSpans,
      'exactly one auth.session.step_up_check span on the blocked path',
    ).toHaveLength(1);
    expect(stepUpCheckSpans[0]?.attributes).toEqual({
      'tayzu.auth.method': 'local',
      'tayzu.auth.step_up.fresh': false,
    });
  });

  it('High-risk operation with a fresh MFA verification succeeds', async () => {
    const user = await signUpWithFreshMfaVerification();

    await harness.reset();

    const params: AssertStepUpParams = {
      headers: new Headers({ cookie: user.cookie }),
      tenantId: user.organizationId,
      actor: { type: 'user', id: user.userId },
      route: HIGH_RISK_ROUTE,
      operation: BLUEPRINT_DELETE_OPERATION,
    };

    // WHEN "they call `blueprints.delete` on an otherwise-deletable
    // blueprint". THEN "the deletion proceeds": the guard resolves, and the
    // stand-in handler runs exactly once.
    const { handler } = await invokeGuarded(params);
    expect(handler, 'the deletion handler runs').toHaveBeenCalledTimes(1);

    await harness.forceFlush();

    // Never a false positive on the success path.
    expect(finishedLogRecords(harness.logExporter, 'auth.security.step_up_required')).toHaveLength(
      0,
    );
    expect(sumDataPoints(harness.metricExporter, 'tayzu.auth.step_up.required')).toHaveLength(0);

    // Telemetry fix-up (design.md, Spans table: `auth.session.
    // step_up_check`): the span still fires on this allowed path -- "any
    // `x-tayzu-risk: high` operation invoked by a `user` actor" names no
    // allow/block distinction -- with `tayzu.auth.step_up.fresh: true`.
    const stepUpCheckSpans = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.name === 'auth.session.step_up_check');
    expect(
      stepUpCheckSpans,
      'exactly one auth.session.step_up_check span on the fresh path',
    ).toHaveLength(1);
    expect(stepUpCheckSpans[0]?.attributes).toEqual({
      'tayzu.auth.method': 'local',
      'tayzu.auth.step_up.fresh': true,
    });
  });

  it('High-risk operation by an integration actor is not gated by step-up', async () => {
    await harness.reset();

    // GIVEN "an `integration` actor authorized by Cerbos to delete a
    // blueprint": no Better Auth session at all -- design D4's own
    // restriction ("`agent`/`integration`/`system` actors skip this guard
    // entirely") means the guard must not even need one for a non-`user`
    // actor.
    const params: AssertStepUpParams = {
      headers: new Headers(),
      tenantId: randomUUID(),
      actor: { type: 'integration', id: randomUUID() },
      route: HIGH_RISK_ROUTE,
      operation: BLUEPRINT_DELETE_OPERATION,
    };

    // WHEN "it calls `blueprints.delete`". THEN "the deletion proceeds
    // without any step-up check": the guard resolves (no session needed, no
    // rejection), and the stand-in handler runs exactly once.
    const { handler } = await invokeGuarded(params);
    expect(handler, 'the deletion handler runs').toHaveBeenCalledTimes(1);

    await harness.forceFlush();

    // Never gated, and never mistakenly counted as a step-up friction event.
    expect(finishedLogRecords(harness.logExporter, 'auth.security.step_up_required')).toHaveLength(
      0,
    );
    expect(sumDataPoints(harness.metricExporter, 'tayzu.auth.step_up.required')).toHaveLength(0);

    // Telemetry fix-up (design.md, Spans table: `auth.session.
    // step_up_check`, "invoked by a `user` actor"): an `integration` actor is
    // out of that span's own declared scope, matching the guard's existing
    // early return for non-`user` actors -- never emitted here.
    expect(
      harness.spanExporter
        .getFinishedSpans()
        .filter((span) => span.name === 'auth.session.step_up_check'),
      'no step_up_check span for a non-user actor',
    ).toHaveLength(0);
  });
});
