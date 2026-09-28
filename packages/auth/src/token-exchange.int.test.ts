/**
 * Integration test for task 5.3 (design D5; `specs/auth-and-rbac/spec.md`,
 * "Machine credentials"; design.md, "Observability contract" -> Spans table
 * row `auth.token.exchange` and Metrics table row `tayzu.auth.token.
 * exchanges`).
 *
 * "`POST /v1/auth/token`: `verifyApiKey` then a 1-hour access token minted
 * through the `jwt` plugin, scoped to the credential's `tenantId` and
 * `actorKind`." This file covers exactly the three scenarios task 5.3's own
 * Verify clause names, quoted from `specs/auth-and-rbac/spec.md`:
 *
 * #### Scenario: Valid client id and secret exchange for an access token
 * - GIVEN an active `integration`-kind machine credential
 * - WHEN its client id and secret are posted to `POST /v1/auth/token`
 * - THEN an access token is returned that resolves to `actor.type` `integration`
 *
 * #### Scenario: Wrong secret is rejected
 * - WHEN a valid client id is posted with an incorrect secret
 * - THEN it fails with `AUTH_INVALID_CREDENTIALS`
 *
 * #### Scenario: Revoked credential is rejected
 * - GIVEN a machine credential that has been revoked
 * - WHEN its client id and secret are posted to `POST /v1/auth/token`
 * - THEN it fails with `AUTH_INVALID_CREDENTIALS`
 *
 * plus task 5.3's own "the `auth.token.exchange` span and `tayzu.auth.token.
 * exchanges` counter" (design.md, "Observability contract" -> Spans table:
 * `auth.token.exchange`, `POST /v1/auth/token`, required attribute `tayzu.
 * auth.credential.kind` (`integration`|`agent`), no conditional attribute;
 * Metrics table: `tayzu.auth.token.exchanges`, Counter `{exchange}`,
 * attributes `tayzu.auth.credential.kind`, `tayzu.auth.exchange.outcome`
 * (`success`|`invalid_credentials`)), asserted on the success scenario below,
 * where both attributes are unambiguous (see "Why this file only asserts
 * telemetry on the success scenario" further down).
 *
 * The requirement text above these scenarios (same spec section) is the
 * source for "MUST fail with `AUTH_INVALID_CREDENTIALS`" and the design
 * mechanism: "A new procedure, `POST /v1/auth/token`, is **not** part of
 * Better Auth's own route set. It calls `auth.api.verifyApiKey({ body: { key
 * } })`; on success it mints a 1-hour token via the `jwt` plugin
 * (`auth.api.getToken`-equivalent, scoped to `{ tenantId: key.referenceId,
 * actor: { type: key.metadata.actorKind, id: key.id } }`), signed with the
 * `jwt` plugin's own key ... On failure it returns `AUTH_INVALID_CREDENTIALS`."
 * (design D5). "`actorKind` (`integration` or `agent`) is fixed at
 * credential-creation time via the config's `metadata`, never chosen by the
 * caller of `POST /v1/auth/token`" (design D5) is exactly why the decoded
 * token's `actor.type` is asserted against the credential's own
 * creation-time `actorKind` (`'integration'`) below, not against anything the
 * exchange call itself supplies.
 *
 * ## Module under test, and why its shape is this file's own design decision
 *
 * No file named `token-exchange.ts` (or anything similar) exists anywhere in
 * `packages/auth/src` yet (confirmed by listing the directory before writing
 * this file) -- task 5.3 is genuinely new production code, not an extension
 * of an existing module. Design D5 names the mechanism (`auth.api.
 * verifyApiKey` then a `jwt`-plugin-signed token) but no concrete
 * wrapper-function signature, so -- the same "flagged here, in case the
 * green phase settles on a different shape" practice `machine-credentials.
 * int.test.ts`'s own module doc comment (task 5.1) and `step-up.int.test.ts`'s
 * own module doc comment (task 4.2) both establish for this package -- this
 * file assumes `./token-exchange.ts` exports:
 *
 * - `exchangeMachineToken(auth, params)`, the same `functionName(auth,
 *   params)` convention `./machine-credentials.ts`'s own
 *   `createMachineCredential`/`revokeMachineCredential` already establish for
 *   this package's one-shot, non-guard actions (as opposed to the `create*({
 *   auth })` factory `./context-resolver.ts`/`./step-up.ts` use for
 *   long-lived guards held across requests -- a token exchange is a single
 *   call, not a reusable guard).
 * - `ExchangeMachineTokenParams`: `clientId`/`clientSecret` (the requirement
 *   text's own wording, "a valid, non-revoked client id and its matching
 *   secret"; `clientId` is `CreatedMachineCredential['id']`, `clientSecret`
 *   is `CreatedMachineCredential['secret']`, task 5.1's own field names).
 * - `ExchangedMachineToken`: `accessToken` (a string), the requirement text's
 *   own wording, "MUST return an access token."
 * - Rejects with a `{ code: 'AUTH_INVALID_CREDENTIALS' }`-shaped error on an
 *   invalid, mismatched, or revoked credential -- the same structural-error-
 *   shape convention `./errors.ts`'s own `AuthContextError` (`{ code:
 *   'CATALOG_CONTEXT_REQUIRED' }`) and `AuthStepUpError` (`{ code:
 *   'AUTH_STEP_UP_REQUIRED' }`) already establish for this package, asserted
 *   against here the same structural way `context-resolver.int.test.ts`'s own
 *   `expectContextRequiredRejection` and `step-up.int.test.ts`'s own inline
 *   `toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' })` assertions do, without
 *   this file needing to import a class from `./errors.js` that may not exist
 *   there yet (that file already exists, so a new named export missing from
 *   it would not be "the module under test" this assignment's own
 *   instructions call acceptable -- the structural assertion sidesteps that
 *   entirely, the same way `step-up.int.test.ts`'s own module doc comment
 *   explains for `AuthStepUpError`).
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `./token-exchange.js` does not exist (confirmed above), so every test below
 * fails at import time with a "Cannot find module" error -- the one
 * acceptable missing-module condition this assignment's own instructions name
 * ("acceptable only for the module under test"). Every other import in this
 * file (`./auth.js`, `./machine-credentials.js`, `./__fixtures__/
 * admin-user.js`, `./__fixtures__/registered-harness.js`, `@tayzu/db`) already
 * exists and is exercised unchanged by every other int test file in this
 * package.
 *
 * ## Why this file decodes the returned token without verifying its signature
 *
 * "An access token is returned that resolves to `actor.type` `integration`"
 * is checked by decoding the JWT's payload segment and reading its `actor.
 * type`/`tenantId` claims back -- design D5's own words for the shape this
 * token is "scoped to." Verifying the token's signature against the `jwt`
 * plugin's own JWKS is task 5.4's job (`resolveContext`'s access-token
 * branch, not built yet either): this task's own scenario is about the
 * exchange mechanism returning a token with the right claims, not about
 * re-proving the `jwt` plugin's signing correctness a second time here.
 * `jose` (the library the installed `better-auth@1.7.6` `jwt` plugin itself
 * uses to sign, confirmed by reading `dist/plugins/jwt/sign.mjs`) is only a
 * transitive dependency of this package (`packages/auth/package.json` does
 * not declare it directly, and pnpm's strict `node_modules` layout does not
 * link it into this package for import), so it is not imported here -- Node's
 * own built-in `Buffer` `'base64url'` encoding (Node 22, no dependency) is
 * enough to read the middle segment back.
 *
 * ## Why this file only asserts telemetry on the success scenario
 *
 * The Metrics table's `tayzu.auth.token.exchanges` row lists `tayzu.auth.
 * credential.kind` as a required attribute alongside `tayzu.auth.exchange.
 * outcome`. On the success path, the credential's `actorKind` is
 * unambiguously known (it is the same value `createMachineCredential` fixed
 * at creation and the value the decoded token itself carries). On the
 * "Wrong secret"/"Revoked credential" paths, the installed `@better-auth/
 * api-key@1.7.6` `verifyApiKey` endpoint's own response type (`dist/
 * index-BJOGXZav.d.mts`) returns `key: null` on every failing branch --
 * `./token-exchange.ts` would need its own additional lookup (by `clientId`)
 * to attribute a credential kind to a failed exchange at all, a mechanism
 * design D5 does not name and this file's own instructions do not ask it to
 * invent. Asserting a specific `tayzu.auth.credential.kind` value on those
 * two paths would assume an implementation detail this task's Verify clause
 * does not name; the span/counter check is therefore attached to the one
 * scenario where every required attribute is unambiguous, satisfying "plus
 * the `auth.token.exchange` span and `tayzu.auth.token.exchanges` counter"
 * without overreaching into the two rejection scenarios' own, narrower
 * `AUTH_INVALID_CREDENTIALS` assertions.
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same shared-`DATABASE_URL` / `runMigrations`-per-suite,
 * `randomUUID()`-per-test isolation pattern as every other int test file in
 * this package, and the identical admin-provisioning/credential-creation
 * setup `machine-credentials.int.test.ts` (tasks 5.1-5.2) already
 * establishes: the admin user is provisioned through the admin-creation path
 * (`./__fixtures__/admin-user.js`'s `bootstrapTestTenant`, task 18.1), never
 * Better Auth's own `/sign-up/email` route (`disableSignUp: true`, task
 * 18.2), and every request that fixture makes carries its own fresh, random
 * `x-forwarded-for` IP (`randomIp()`), per this task's own instructions, so
 * no rate limiter interferes. Machine credentials themselves are created
 * through `./machine-credentials.js`'s own, already-green
 * `createMachineCredential`/`revokeMachineCredential` (tasks 5.1-5.2), not
 * reimplemented here.
 *
 * The telemetry harness is registered by `./__fixtures__/registered-harness.js`,
 * imported before `./auth.js` at the top of this file (import order is
 * load-bearing; see that fixture's own doc comment and the identical comment
 * on this file's import block in every other int test file in this package).
 */
import { randomInt, randomUUID } from 'node:crypto';

import type { Attributes } from '@opentelemetry/api';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (task 2.4; design D1; `packages/observability/
// CLAUDE.md`, "Import order"): the harness must register before `./auth.js`'s
// real module runs, before it (and `./token-exchange.js`, once it exists)
// create their tracer, meter instruments and logger at import time.
// `./__fixtures__/admin-user.js`'s own import of `../auth.js` is type-only
// (erased at compile time, `verbatimModuleSyntax`), so it carries no runtime
// ordering weight -- same reasoning as every other int test file in this
// package.
import { bootstrapTestTenant } from './__fixtures__/admin-user.js';
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
import { createMachineCredential, revokeMachineCredential } from './machine-credentials.js';
import type { CreatedMachineCredential } from './machine-credentials.js';
import * as authSchema from './persistence/schema.js';
// The module under test (task 5.3): does not exist yet (module doc comment,
// "Why this is expected to fail for the right reason right now"). Its return
// shape is defined locally, just below, and cast onto this binding once --
// the same "introspect/extend the narrower production type locally" pattern
// `context-resolver.int.test.ts`'s own `ContextResolverFactory` cast already
// establishes for this package, for the identical reason: casting works even
// before `./token-exchange.ts` exists, so every call site below is a
// type-checked, non-`any` function call instead of an unsafe one.
import { exchangeMachineToken } from './token-exchange.js';

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
  return `token-exchange-${randomUUID()}@example.test`;
}

function randomSlug(): string {
  return `token-exchange-org-${randomUUID()}`;
}

/** A password long enough for Better Auth's default 8-character minimum. */
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';
const TEST_ADMIN_NAME = 'Token Exchange Test Admin';

/**
 * The claim shape design D5 names for the minted token: "scoped to `{
 * tenantId: key.referenceId, actor: { type: key.metadata.actorKind, id: key.
 * id } }`" -- the same `{ tenantId, actor: { type, id } }` shape `./context-
 * resolver.ts`'s own `ResolvedContext` already establishes for this package.
 */
interface MachineTokenPayload {
  readonly tenantId?: unknown;
  readonly actor?: {
    readonly type?: unknown;
    readonly id?: unknown;
  };
}

/**
 * Decodes a JWT's payload segment without verifying its signature (see this
 * file's own module doc comment for why signature verification is out of
 * scope here).
 */
function decodeJwtPayloadUnsafe(token: string): MachineTokenPayload {
  const segments = token.split('.');
  const payloadSegment = segments[1];
  if (segments.length !== 3 || payloadSegment === undefined) {
    throw new Error(
      `decodeJwtPayloadUnsafe: expected a 3-segment JWT, got ${String(segments.length)} segment(s)`,
    );
  }
  return JSON.parse(
    Buffer.from(payloadSegment, 'base64url').toString('utf8'),
  ) as MachineTokenPayload;
}

/** design D5, requirement text: "MUST return an access token." */
interface ExchangedMachineToken {
  readonly accessToken: string;
}

interface ExchangeMachineTokenParams {
  readonly clientId: string;
  readonly clientSecret: string;
}

type ExchangeMachineTokenFn = (
  auth: AuthInstance,
  params: ExchangeMachineTokenParams,
) => Promise<ExchangedMachineToken>;

/** Cast once, here, per this file's own import-block comment. */
const exchange: ExchangeMachineTokenFn = exchangeMachineToken as ExchangeMachineTokenFn;

describe('Machine-credential token exchange (task 5.3, design D5)', () => {
  let db: TestDb;
  let auth: AuthInstance;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  /** Provisions "an organization admin" (requirement text) the same way `machine-credentials.int.test.ts` does. */
  async function bootstrapAdmin(): ReturnType<typeof bootstrapTestTenant> {
    return bootstrapTestTenant(auth, {
      name: TEST_ADMIN_NAME,
      email: randomEmail(),
      password: TEST_PASSWORD,
      organizationName: 'Token Exchange Test Org',
      organizationSlug: randomSlug(),
      ip: randomIp(),
    });
  }

  /** Creates "an active `integration`-kind machine credential" (scenario GIVEN). */
  async function createIntegrationCredential(
    admin: Awaited<ReturnType<typeof bootstrapTestTenant>>,
  ): Promise<CreatedMachineCredential> {
    return createMachineCredential(auth, {
      headers: new Headers({ cookie: admin.cookie }),
      organizationId: admin.organizationId,
      name: 'Token exchange test credential',
      actorKind: 'integration',
    });
  }

  it('Valid client id and secret exchange for an access token', async () => {
    const registeredHarness = registration;
    if ('error' in registeredHarness) {
      throw new Error(
        `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registeredHarness.error)}`,
        { cause: registeredHarness.error },
      );
    }
    const harness: TelemetryTestHarness = registeredHarness.harness;

    // GIVEN "an active `integration`-kind machine credential".
    const admin = await bootstrapAdmin();
    const created = await createIntegrationCredential(admin);

    // Discard whatever admin bootstrap/credential creation emitted: only the
    // exchange call below is under test.
    await harness.reset();

    // WHEN "its client id and secret are posted to `POST /v1/auth/token`".
    const exchanged = await exchange(auth, {
      clientId: created.id,
      clientSecret: created.secret,
    });

    // THEN "an access token is returned ...
    expect(typeof exchanged.accessToken, 'the exchange returns a string access token').toBe(
      'string',
    );
    expect(exchanged.accessToken.length, 'the access token is non-empty').toBeGreaterThan(0);

    // ... that resolves to `actor.type` `integration`" -- design D5's own
    // claim shape, `{ tenantId, actor: { type, id } }`.
    const payload = decodeJwtPayloadUnsafe(exchanged.accessToken);
    expect(payload.actor?.type, 'the token resolves to actor.type "integration"').toBe(
      'integration',
    );
    expect(payload.actor?.id, "the token's actor.id is the credential's own client id").toBe(
      created.id,
    );
    expect(
      payload.tenantId,
      "the token is scoped to the credential's own tenantId (organizationId)",
    ).toBe(admin.organizationId);

    // "plus the `auth.token.exchange` span and `tayzu.auth.token.exchanges`
    // counter" (see this file's own module doc comment for why only this
    // scenario asserts telemetry).
    await harness.forceFlush();

    const spans = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.name === 'auth.token.exchange');
    expect(spans, 'exactly one auth.token.exchange span').toHaveLength(1);
    expect(spans[0]?.attributes).toEqual({ 'tayzu.auth.credential.kind': 'integration' });

    const METRIC_DATA_POINT_TYPE_SUM = 3;
    interface CapturedSumPoint {
      readonly attributes: Attributes;
      readonly value: number;
    }
    const points: CapturedSumPoint[] = [];
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (
            metric.descriptor.name === 'tayzu.auth.token.exchanges' &&
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
    expect(points, 'the token-exchanges counter incremented once, for this success').toHaveLength(
      1,
    );
    expect(points[0]?.value).toBe(1);
    expect(points[0]?.attributes).toEqual({
      'tayzu.auth.credential.kind': 'integration',
      'tayzu.auth.exchange.outcome': 'success',
    });
  });

  it('Wrong secret is rejected', async () => {
    // "a valid client id" (scenario WHEN): a real, active credential exists.
    const admin = await bootstrapAdmin();
    const created = await createIntegrationCredential(admin);

    // WHEN "a valid client id is posted with an incorrect secret".
    const rejection = exchange(auth, {
      clientId: created.id,
      clientSecret: 'definitely-the-wrong-secret-not-the-one-created-above',
    });

    // THEN "it fails with `AUTH_INVALID_CREDENTIALS`" -- asserted
    // structurally (see this file's own module doc comment for why).
    await expect(rejection).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('Revoked credential is rejected', async () => {
    // GIVEN "a machine credential that has been revoked".
    const admin = await bootstrapAdmin();
    const created = await createIntegrationCredential(admin);
    await revokeMachineCredential(auth, {
      headers: new Headers({ cookie: admin.cookie }),
      id: created.id,
    });

    // WHEN "its client id and secret are posted to `POST /v1/auth/token`".
    const rejection = exchange(auth, {
      clientId: created.id,
      clientSecret: created.secret,
    });

    // THEN "it fails with `AUTH_INVALID_CREDENTIALS`" -- asserted
    // structurally (see this file's own module doc comment for why).
    await expect(rejection).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
  });
});
