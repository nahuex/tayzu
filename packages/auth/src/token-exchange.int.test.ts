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
 * (`success`|`invalid_credentials`); Log events table: `auth.security.
 * token_exchange_failed`, WARN, attribute `tayzu.auth.credential.kind`),
 * asserted below on all three scenarios -- see "Why the two rejection
 * scenarios assert `tayzu.auth.credential.kind` differently" further down for
 * why "Wrong secret" and "Revoked credential" assert a different value (or
 * absence) of that one attribute from each other and from the success case.
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
 * ## Module under test
 *
 * `./token-exchange.ts` (task 5.3) exists and is already green for the three
 * scenario assertions above: it exports `exchangeMachineToken(auth, params)`,
 * `ExchangeMachineTokenParams` (`clientId`/`clientSecret`), and
 * `ExchangedMachineToken` (`accessToken`) exactly as this file originally
 * assumed before that module existed -- imported directly below, no longer
 * through a locally-declared "assumed API" type and cast (see "Why the
 * `as ExchangeMachineTokenFn` cast is gone" further down). It rejects with a
 * `{ code: 'AUTH_INVALID_CREDENTIALS' }`-shaped error (`./errors.ts`'s
 * `AuthInvalidCredentialsError`) on an invalid, mismatched, or revoked
 * credential, asserted structurally below, the same way
 * `context-resolver.int.test.ts`'s own `expectContextRequiredRejection` and
 * `step-up.int.test.ts`'s own inline `toMatchObject({ code:
 * 'AUTH_STEP_UP_REQUIRED' })` assertions do.
 *
 * This is a **telemetry fix-up** (`observability-auditor` BLOCK on tasks 5.3/
 * 4.2): `exchangeMachineToken` currently emits the `auth.token.exchange` span
 * and `tayzu.auth.token.exchanges` counter (with `tayzu.auth.exchange.outcome`
 * `success`) on the success path only, and never emits
 * `auth.security.token_exchange_failed` at all. Every rejection path
 * (`AuthInvalidCredentialsError`, confirmed by reading `./token-exchange.ts`'s
 * own `throw new AuthInvalidCredentialsError()` call sites) returns before any
 * of these three signals fire. The two rejection scenarios below are extended
 * to assert all three, and are expected to fail against the currently-green
 * production code for exactly that reason: an assertion failure (the
 * declared span/counter/log record is simply absent), never a missing-module
 * or syntax error -- see each scenario's own comment below for the precise
 * expected failure.
 *
 * ## Why the `as ExchangeMachineTokenFn` cast is gone
 *
 * The original (task 5.3 red-phase) version of this file cast
 * `exchangeMachineToken` onto a locally-declared `ExchangeMachineTokenFn` type
 * because `./token-exchange.ts` did not exist yet and the import resolved to
 * `any` -- the same "introspect/extend the narrower production type locally"
 * pattern this package's other int test files establish while their own
 * module under test doesn't exist yet. `./token-exchange.ts` now exists with
 * exactly that assumed shape (confirmed above), so the cast is provably
 * unnecessary (`@typescript-eslint/no-unnecessary-type-assertion`, exempted
 * for this file only in `eslint.config.js` for exactly this reason). Removing
 * it here lets that now-stale exemption be dropped from `eslint.config.js`
 * (a non-test file, out of this file's own scope to edit).
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
 * ## Why the two rejection scenarios assert `tayzu.auth.credential.kind` differently
 *
 * The Spans/Metrics/Log-events tables all list `tayzu.auth.credential.kind`
 * as an attribute of `auth.token.exchange`/`tayzu.auth.token.exchanges`/
 * `auth.security.token_exchange_failed` with no "conditional" marker and no
 * third, "unknown" enum value beyond `integration`|`agent` -- but the
 * installed `@better-auth/api-key@1.7.6` `verifyApiKey` endpoint (`dist/
 * index.mjs`, read in full before writing this file) makes the two rejection
 * scenarios genuinely different in whether that value is knowable at all:
 *
 * - **"Wrong secret is rejected"**: `verifyApiKey`'s own `key` parameter is
 *   the *secret* alone (`clientId` is never sent, confirmed by this file's
 *   own call sites below and by `./token-exchange.ts`'s own `body: { key:
 *   params.clientSecret, ... }`) -- `validateApiKey` looks the row up by
 *   secret hash, and a wrong secret matches no row at all
 *   (`APIError.from("UNAUTHORIZED", API_KEY_ERROR_CODES.INVALID_API_KEY)`,
 *   `dist/index.mjs` line ~1625). Mechanically, this scenario's "a valid
 *   client id ... with an incorrect secret" (requirement text) is a
 *   **credential-not-found** case from `verifyApiKey`'s own point of view:
 *   nothing in the response, or in any mechanism design D5 names, tells
 *   `./token-exchange.ts` what kind that never-found row would have been.
 *   Per this task's own instructions ("if the design makes the kind
 *   attribute required on failures, assert the value the design specifies,
 *   otherwise assert it is absent"): the design specifies no value for an
 *   unknown kind (only the closed `integration`|`agent` enum), so this file
 *   asserts the attribute is **absent** on all three signals for this
 *   scenario -- reported here, per this task's own instructions, as the
 *   choice made and why.
 * - **"Revoked credential is rejected"**: the *same* lookup finds the row
 *   (the secret matches -- it is the one real secret `createMachineCredential`
 *   returned), then rejects it for being disabled
 *   (`API_KEY_ERROR_CODES.KEY_DISABLED`, same file, line ~1634) -- the
 *   credential, and therefore its `actorKind`, is genuinely known at the
 *   point of rejection, even though the installed endpoint's own public
 *   response shape (`{ valid: false, key: null }`) currently discards it
 *   before returning. This file therefore asserts the attribute **is**
 *   present, with the real value ("integration", the kind `createMachine
 *   Credential` was called with in this file's own `createIntegrationCredential`
 *   helper) -- the green phase is expected to recover it (for example, a
 *   direct lookup by `clientId` on the `KEY_DISABLED` branch specifically),
 *   not to invent a mechanism this file assumes for it.
 *
 * Both rejection scenarios still assert `tayzu.auth.exchange.outcome`:
 * `invalid_credentials` (the one attribute the design leaves unambiguous on
 * every failure, independent of whether the kind is knowable), and the
 * `auth.security.token_exchange_failed` log event at WARN with exactly the
 * same knowable-or-absent `tayzu.auth.credential.kind` attribute the Log
 * events table names as its only one. Every assertion below also checks that
 * the credential's own client id, its client secret, and (on the success
 * path) the minted access token never appear on any of the three signals
 * (`expectNoSecretsInTelemetry`, mirroring `auth-flow.int.test.ts`'s own
 * identically-named helper).
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
import { SeverityNumber } from '@opentelemetry/api-logs';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (task 2.4; design D1; `packages/observability/
// CLAUDE.md`, "Import order"): the harness must register before `./auth.js`'s
// real module runs, before it (and `./token-exchange.js`) create their
// tracer, meter instruments and logger at import time. `./__fixtures__/
// admin-user.js`'s own import of `../auth.js` is type-only (erased at compile
// time, `verbatimModuleSyntax`), so it carries no runtime ordering weight --
// same reasoning as every other int test file in this package.
import { bootstrapTestTenant } from './__fixtures__/admin-user.js';
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
import { createMachineCredential, revokeMachineCredential } from './machine-credentials.js';
import type { CreatedMachineCredential } from './machine-credentials.js';
import * as authSchema from './persistence/schema.js';
// The module under test (task 5.3, telemetry fix-up): exists (module doc
// comment, "Module under test"). Its exported types are used directly here --
// no more locally-declared "assumed API" type/cast, now that the real module
// exists with exactly that shape (see "Why the `as ExchangeMachineTokenFn`
// cast is gone").
import { exchangeMachineToken } from './token-exchange.js';
import type { ExchangeMachineTokenParams, ExchangedMachineToken } from './token-exchange.js';
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
  return `token-exchange-${randomUUID()}@example.test`;
}

function randomSlug(): string {
  return `token-exchange-org-${randomUUID()}`;
}

/** A password long enough for Better Auth's default 8-character minimum. */
const TEST_PASSWORD = 'correct horse battery staple';
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

/**
 * `./token-exchange.ts`'s own `exchangeMachineToken`, called directly -- no
 * cast needed now that the real module exists (see this file's own module
 * doc comment, "Why the `as ExchangeMachineTokenFn` cast is gone").
 */
const exchange: (
  auth: AuthInstance,
  params: ExchangeMachineTokenParams,
) => Promise<ExchangedMachineToken> = exchangeMachineToken;

describe('Machine-credential token exchange (task 5.3, design D5)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  // Security fix-up (tasks 5.6/5.7): revocation always carries the `tayzu_app`
  // pool and the host tenantId.
  let appPool: TestDb['$client'];

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    appPool = connect(databaseUrl()).$client;
    appPool.on('connect', (client) => {
      void client.query('SET ROLE tayzu_app');
    });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(appPool);
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

  /** Same pattern as `auth-flow.int.test.ts`'s/`step-up.int.test.ts`'s own identically-named helper. */
  function finishedLogRecords(
    exporter: LogExporterLike,
    eventName: string,
  ): ReadableLogRecordLike[] {
    return [...exporter.getFinishedLogRecords()].filter((record) => record.eventName === eventName);
  }

  /**
   * `@opentelemetry/sdk-metrics`'s `DataPointType.SUM` value, inlined rather
   * than imported -- same rationale, and the same value, as every other int
   * test file in this package's identical constant.
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

  /**
   * A minimal, JSON-serializable snapshot of everything the harness has
   * captured so far across all three signal kinds (span attributes, log
   * attributes/body, metric data-point attributes) -- same rationale as
   * `auth-flow.int.test.ts`'s own identically-purposed
   * `serializedTelemetrySnapshot`/`expectNoSecretsInTelemetry`, extended here
   * with span attributes since this file's own new assertions cover
   * `auth.token.exchange` (a span), not only the counter/log Better Auth's
   * sign-in flow emits.
   */
  function serializedTelemetrySnapshot(harness: TelemetryTestHarness): string {
    const logs = [...harness.logExporter.getFinishedLogRecords()].map((record) => ({
      attributes: record.attributes,
      body: record.body,
    }));
    const spanAttributes = [...harness.spanExporter.getFinishedSpans()].map(
      (span) => span.attributes,
    );
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
    return JSON.stringify({ logs, spanAttributes, metricAttributes });
  }

  /**
   * Asserts that none of `secrets` (a client id, a client secret, a minted
   * access token -- anything that must never reach telemetry, per root
   * `CLAUDE.md`, "No tenant free text in telemetry or errors", extended by
   * design.md's own "client secrets, access tokens ... in raw or hashed form")
   * appears anywhere in what the harness has captured so far.
   */
  function expectNoSecretsInTelemetry(
    harness: TelemetryTestHarness,
    secrets: readonly string[],
  ): void {
    const snapshot = serializedTelemetrySnapshot(harness);
    for (const secret of secrets) {
      expect(snapshot, `telemetry must never contain ${JSON.stringify(secret)}`).not.toContain(
        secret,
      );
    }
  }

  it('Valid client id and secret exchange for an access token', async () => {
    const harness = registeredHarness();

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
    // counter" (design.md, "Observability contract").
    await harness.forceFlush();

    const spans = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.name === 'auth.token.exchange');
    expect(spans, 'exactly one auth.token.exchange span').toHaveLength(1);
    expect(spans[0]?.attributes).toEqual({ 'tayzu.auth.credential.kind': 'integration' });

    const points = sumDataPoints(harness.metricExporter, 'tayzu.auth.token.exchanges');
    expect(points, 'the token-exchanges counter incremented once, for this success').toHaveLength(
      1,
    );
    expect(points[0]?.value).toBe(1);
    expect(points[0]?.attributes).toEqual({
      'tayzu.auth.credential.kind': 'integration',
      'tayzu.auth.exchange.outcome': 'success',
    });

    // No log event is declared for the success path (Log events table names
    // `auth.security.token_exchange_failed` only, on failure).
    expect(
      finishedLogRecords(harness.logExporter, 'auth.security.token_exchange_failed'),
    ).toHaveLength(0);

    // Never a client id, a client secret, or the minted access token itself.
    expectNoSecretsInTelemetry(harness, [created.id, created.secret, exchanged.accessToken]);
  });

  it('Wrong secret is rejected', async () => {
    const harness = registeredHarness();

    // "a valid client id" (scenario WHEN): a real, active credential exists.
    const admin = await bootstrapAdmin();
    const created = await createIntegrationCredential(admin);

    // Discard whatever admin bootstrap/credential creation emitted: only the
    // exchange call below is under test.
    await harness.reset();

    // WHEN "a valid client id is posted with an incorrect secret".
    const rejection = exchange(auth, {
      clientId: created.id,
      clientSecret: 'definitely-the-wrong-secret-not-the-one-created-above',
    });

    // THEN "it fails with `AUTH_INVALID_CREDENTIALS`" -- asserted
    // structurally (see this file's own module doc comment for why).
    await expect(rejection).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });

    // AND (telemetry fix-up, `observability-auditor` BLOCK on task 5.3): the
    // `auth.token.exchange` span, the `tayzu.auth.token.exchanges` counter
    // (`tayzu.auth.exchange.outcome` `invalid_credentials`), and the
    // `auth.security.token_exchange_failed` WARN log all fire on this
    // rejection too -- not only on success. This scenario's own credential
    // lookup never finds a matching row (see this file's own module doc
    // comment, "Why the two rejection scenarios assert `tayzu.auth.
    // credential.kind` differently"), so `tayzu.auth.credential.kind` is
    // **absent** on all three signals here, unlike the "Revoked credential"
    // scenario below.
    await harness.forceFlush();

    const spans = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.name === 'auth.token.exchange');
    expect(spans, 'exactly one auth.token.exchange span for the rejected exchange').toHaveLength(1);
    expect(
      spans[0]?.attributes,
      'no credential.kind attribute: the credential was not found',
    ).toEqual({});

    const points = sumDataPoints(harness.metricExporter, 'tayzu.auth.token.exchanges');
    expect(points, 'the token-exchanges counter incremented once, for this rejection').toHaveLength(
      1,
    );
    expect(points[0]?.value).toBe(1);
    expect(points[0]?.attributes).toEqual({
      'tayzu.auth.exchange.outcome': 'invalid_credentials',
    });

    const logs = finishedLogRecords(harness.logExporter, 'auth.security.token_exchange_failed');
    expect(logs, 'exactly one token_exchange_failed log record').toHaveLength(1);
    expect(logs[0]?.severityNumber).toBe(SeverityNumber.WARN);
    expect(
      logs[0]?.attributes,
      'no credential.kind attribute: the credential was not found',
    ).toEqual({});

    // Never the credential's client id or its (wrong) client secret.
    expectNoSecretsInTelemetry(harness, [
      created.id,
      created.secret,
      'definitely-the-wrong-secret-not-the-one-created-above',
    ]);
  });

  it('Revoked credential is rejected', async () => {
    const harness = registeredHarness();

    // GIVEN "a machine credential that has been revoked".
    const admin = await bootstrapAdmin();
    const created = await createIntegrationCredential(admin);
    await revokeMachineCredential(auth, {
      headers: new Headers({ cookie: admin.cookie }),
      id: created.id,
      pool: appPool,
      tenantId: admin.organizationId,
    });

    // Discard whatever admin bootstrap/credential-creation/revocation
    // emitted: only the exchange call below is under test.
    await harness.reset();

    // WHEN "its client id and secret are posted to `POST /v1/auth/token`".
    const rejection = exchange(auth, {
      clientId: created.id,
      clientSecret: created.secret,
    });

    // THEN "it fails with `AUTH_INVALID_CREDENTIALS`" -- asserted
    // structurally (see this file's own module doc comment for why).
    await expect(rejection).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });

    // AND (telemetry fix-up, `observability-auditor` BLOCK on task 5.3): same
    // three signals as "Wrong secret" above, but this scenario's own
    // credential lookup *does* find the (disabled) row by its real secret, so
    // `tayzu.auth.credential.kind` is the real, known value here (see this
    // file's own module doc comment for why this differs from "Wrong secret"
    // above).
    await harness.forceFlush();

    const spans = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.name === 'auth.token.exchange');
    expect(spans, 'exactly one auth.token.exchange span for the rejected exchange').toHaveLength(1);
    expect(spans[0]?.attributes).toEqual({ 'tayzu.auth.credential.kind': 'integration' });

    const points = sumDataPoints(harness.metricExporter, 'tayzu.auth.token.exchanges');
    expect(points, 'the token-exchanges counter incremented once, for this rejection').toHaveLength(
      1,
    );
    expect(points[0]?.value).toBe(1);
    expect(points[0]?.attributes).toEqual({
      'tayzu.auth.credential.kind': 'integration',
      'tayzu.auth.exchange.outcome': 'invalid_credentials',
    });

    const logs = finishedLogRecords(harness.logExporter, 'auth.security.token_exchange_failed');
    expect(logs, 'exactly one token_exchange_failed log record').toHaveLength(1);
    expect(logs[0]?.severityNumber).toBe(SeverityNumber.WARN);
    expect(logs[0]?.attributes).toEqual({ 'tayzu.auth.credential.kind': 'integration' });

    // Never the credential's client id or its client secret.
    expectNoSecretsInTelemetry(harness, [created.id, created.secret]);
  });
});
