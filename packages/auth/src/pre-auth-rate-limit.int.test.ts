/**
 * Integration test for task 2.5 (design D20; specs/auth-and-rbac/spec.md,
 * "Pre-authentication rate limiting protects against credential stuffing").
 *
 * "Better Auth `rateLimit` config: `storage: "database"`, `customRules` for
 * `/sign-in/email`, `/two-factor/verify`, and any sign-up/email-verification
 * route, each keyed by IP and by normalized email (design D20)." This file
 * covers exactly the scenario task 2.5's own Verify clause names,
 * "Repeated failed sign-ins from the same source are rate-limited"
 * (`AUTH_RATE_LIMITED`, `Retry-After` header), plus the `auth.security.
 * rate_limited` log event and `tayzu.auth.rate_limit.events` counter, with
 * neither IP nor email present on either signal. `/two-factor/verify` and
 * sign-up/email-verification are later/other tasks' concern, not exercised
 * here; the machine-token-exchange rate limit (the other named scenario in
 * the same requirement) is task 11.13's `@fastify/rate-limit` bucket, not
 * this one.
 *
 * ## Why `auth.handler(new Request(...))`, not `auth.api.signInEmail`
 *
 * `apps/api` (group 11) does not exist yet, so — same as `auth-flow.int.
 * test.ts` (task 2.3) — this file drives the production `createAuth`
 * instance directly, in-process. Unlike that file, this one calls `auth.
 * handler(new Request(...))` rather than `auth.api.signInEmail(...)`,
 * because the caller's IP has to travel as a real HTTP header
 * (`x-forwarded-for`, Better Auth's own default `ipAddressHeaders`, verified
 * against the installed `@better-auth/core@1.7.6` source, `dist/utils/ip.
 * mjs`'s `DEFAULT_IP_HEADERS`) for any IP-keyed rate limit to see a
 * different caller per request; `auth.api.*` calls bypass the HTTP request
 * object entirely (verified against the installed `better-auth@1.7.6`
 * source: `auth.api.signInEmail` invokes the endpoint function directly,
 * never through `auth.handler`'s router, so `onRequest`-stage rate limiting
 * — built-in or custom — never runs for it).
 *
 * No `baseURL` needs to be configured on `createAuth` for `.handler(...)` to
 * work: when `options.baseURL` is unset, Better Auth derives `ctx.baseURL`
 * fresh, per request, from the `Request`'s own absolute URL (verified
 * against the installed source, `dist/auth/base.mjs`'s `handler`: `if
 * (!ctx.options.baseURL) { const baseURL = getBaseURL(void 0, basePath,
 * request, ...) }`), so every request below targets `http://localhost:3000/
 * api/auth/sign-in/email` and lets Better Auth resolve its own origin from
 * that URL, exactly as `better-auth`'s own `getTestInstance` test harness
 * does (`dist/test-utils/test-instance.mjs`, `customFetchImpl`).
 *
 * ## Why this test passes an explicit `rateLimit` option to `createAuth`
 *
 * Design D20 leaves the exact attempt limit to configuration ("the
 * configured sign-in attempt limit", spec). `./auth.ts` (tasks 2.1-2.4) has
 * no rate-limit-related option today. This file introduces the option the
 * green phase is expected to add: `CreateAuthOptions.rateLimit.signIn:
 * { window: number (seconds); max: number }`, fixed here to a small `window:
 * 60, max: 3` so the test runs fast and deterministically without waiting
 * out a real window. This is a test-writer design choice, not something the
 * design or spec names verbatim — flagged here and in the test-writer's
 * report to the orchestrator. The option is passed through a local
 * `RateLimitedCreateAuthOptions` type (an intersection over the production
 * `CreateAuthOptions`, the same "introspect/extend the narrower production
 * type locally" pattern `auth-flow.int.test.ts`'s own `AuthApiSurface`
 * already establishes for `auth.api`), so this file type-checks today
 * without needing the field to exist on `CreateAuthOptions` yet — passing it
 * to `createAuth` (typed `CreateAuthOptions`) is a plain widening
 * assignment, not a fresh-object-literal excess-property check.
 *
 * ## Why the response shape assertions are what they are, not Better Auth's built-in shape
 *
 * Better Auth's own built-in IP+path rate limiter (`ctx.rateLimit`,
 * `onRequestRateLimit`, verified against the installed source, `dist/api/
 * rate-limiter/index.mjs`) can only ever key on `` `${ip}|${path}` `` — it
 * has no email dimension at all, and returns a *generic* `{ message }` JSON
 * body with an `X-Retry-After` header, not `Retry-After` and not `code:
 * "AUTH_RATE_LIMITED"`. Worse, that response is returned directly from the
 * router's `onRequest` stage and — verified against the installed `better-
 * call@1.4.0` source, `dist/router.mjs`: `if (onReq instanceof Response)
 * return onReq;` — never reaches `onResponse`, so no response-shaping hook
 * downstream of it could fix the header/body shape either. So whatever the
 * green phase implements, it cannot be "just enable Better Auth's built-in
 * `customRules`" for either dimension: both the IP-only and the
 * email-only paths below must end up producing the *same*, `AUTH_RATE_
 * LIMITED` + `Retry-After` shape the spec names, from whatever mechanism
 * actually implements the check-and-respond step.
 *
 * ## Why the "normalized email" case includes a whitespace-padded variant
 *
 * `/sign-in/email`'s own schema validates `email` with a bare `z.string()`
 * (no trim) and then a separate `z.email().safeParse(email)` guard inside
 * the endpoint handler itself (verified against the installed source,
 * `dist/api/routes/sign-in.mjs`, and against the installed `zod@4.6.5`
 * directly: `z.email().safeParse('  foo@example.com  ').success` is
 * `false`) — so a literal leading/trailing-whitespace email is rejected by
 * Better Auth's own validation before any handler logic runs, *if* the
 * rate-limit check runs after that validation. The spec's own wording is
 * "keyed by ... a normalized (lowercased, trimmed) email" (design D20): for
 * that trimming to have any observable effect at all, the email-keyed check
 * has to run early enough (at the same `onRequest` stage the built-in IP
 * check itself runs at, before routing/schema validation) to see the raw,
 * unvalidated `email` field and count the padded variant into the same
 * bucket as its trimmed form — and, once that bucket is over its limit, to
 * respond `429`/`AUTH_RATE_LIMITED` *before* Better Auth's own `BAD_REQUEST`
 * validation error ever has a chance to fire. The third scenario below
 * asserts exactly that: the breaching attempt in the "normalized email"
 * scenario carries whitespace, and the assertion is `429`, not `400`.
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `./auth.ts` (tasks 2.1-2.4) never sets any `rateLimit` option and has no
 * `CreateAuthOptions.rateLimit` field. Every request in every scenario below
 * therefore succeeds through Better Auth's ordinary, unthrottled sign-in
 * path (an unconfigured `rateLimit` block is only ever `enabled` in
 * production, and even then only keys `${ip}|${path}`, never email) — so
 * every scenario's final, supposedly-blocked attempt returns Better Auth's
 * ordinary `401 INVALID_EMAIL_OR_PASSWORD` instead of `429`, an assertion
 * failure, not a missing export or a typo: `./auth.js`, `createAuth` and
 * every table this file queries already exist (tasks 2.1-2.4).
 */
import { randomInt, randomUUID } from 'node:crypto';

import type { Attributes } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (task 2.4; design D1; `packages/observability/
// CLAUDE.md`, "Import order"): the harness must register before `./auth.js`,
// which is expected to import a telemetry/instruments module that creates
// its tracer, meter and logger at import time. See `auth-flow.int.test.ts`'s
// identical comment on its own, equally-ordered import block.
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance, type CreateAuthOptions } from './auth.js';
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

const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';

/**
 * A test-writer design choice (see module doc comment): the design leaves
 * the exact sign-in attempt limit to configuration, so this file fixes small
 * numbers itself and passes them through a new `CreateAuthOptions.rateLimit`
 * option the green phase is expected to add.
 */
const SIGN_IN_RATE_LIMIT_WINDOW_SECONDS = 60;
const SIGN_IN_RATE_LIMIT_MAX = 3;

/**
 * The narrower production option type this file expects `createAuth` to
 * grow (task 2.5's green phase), expressed as a local extension over the
 * real `CreateAuthOptions` so this file type-checks today regardless of
 * whether the field exists yet (see module doc comment) — the same pattern
 * `auth-flow.int.test.ts`'s own `AuthApiSurface` already establishes for
 * `auth.api`.
 */
interface RateLimitedCreateAuthOptions extends CreateAuthOptions {
  readonly rateLimit: {
    readonly signIn: {
      readonly window: number;
      readonly max: number;
    };
  };
}

/** `./auth.ts`'s `AuthInstance.api` is typed `unknown`; `.handler` is Better Auth's real, documented HTTP entry point (`dist/types/auth.d.mts`: `handler: (request: Request) => Promise<Response>`), not otherwise exposed on `AuthInstance` yet. */
function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

const SIGN_IN_URL = 'http://localhost:3000/api/auth/sign-in/email';

/** Long enough to clear Better Auth's own password-length floor; the account never exists anyway. */
const WRONG_PASSWORD = 'definitely the wrong password, not correct';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function randomEmail(): string {
  return `rate-${randomUUID()}@example.test`;
}

/** Deterministic, alternating-case transform of an already-valid email: still a valid email by `z.email()`, only its casing differs. */
function withAlternatingCase(email: string): string {
  return email
    .split('')
    .map((char, index) => (index % 2 === 0 ? char.toUpperCase() : char.toLowerCase()))
    .join('');
}

interface SignInAttempt {
  readonly ip: string;
  readonly email: string;
}

function postSignIn(
  handler: (request: Request) => Promise<Response>,
  attempt: SignInAttempt,
): Promise<Response> {
  return handler(
    new Request(SIGN_IN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': attempt.ip,
      },
      body: JSON.stringify({ email: attempt.email, password: WRONG_PASSWORD }),
    }),
  );
}

/** An attempt under the configured limit is processed normally (Better Auth's ordinary, enumeration-resistant `401`), not rate-limited. */
function expectOrdinaryFailure(response: Response): void {
  expect(response.status, 'an attempt under the limit is not rate-limited').toBe(401);
}

interface AuthErrorBody {
  readonly code?: string;
}

/** Spec: "fails with `AUTH_RATE_LIMITED` and a `Retry-After` header" (design D20). */
async function expectBlockedByRateLimit(response: Response): Promise<void> {
  expect(response.status, 'the breaching attempt is rejected with 429').toBe(429);
  const retryAfter = response.headers.get('retry-after');
  expect(retryAfter, 'a Retry-After header is present').not.toBeNull();
  expect(Number(retryAfter), 'Retry-After is a positive number of seconds').toBeGreaterThan(0);
  const body = (await response.json()) as AuthErrorBody;
  expect(body.code, 'the error code is AUTH_RATE_LIMITED').toBe('AUTH_RATE_LIMITED');
}

describe('Pre-authentication sign-in rate limiting (task 2.5, design D20)', () => {
  let db: TestDb;
  let auth: AuthInstance;
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

  /** `@opentelemetry/sdk-metrics`'s `DataPointType.SUM` value, inlined (same rationale as `auth-flow.int.test.ts`'s identical constant: `@tayzu/auth` does not depend on `@opentelemetry/sdk-metrics` directly). */
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

  /** design.md, Log events table: `auth.security.rate_limited`'s only attribute (design D20). */
  const RATE_LIMIT_SCOPE_ATTRIBUTE = 'tayzu.auth.rate_limit.scope';

  /**
   * Spec: "Every rate-limit rejection MUST be recorded as a security log
   * event and a metric" (design D20's `auth.security.rate_limited` /
   * `tayzu.auth.rate_limit.events`). Each test below triggers exactly one
   * breaching attempt, so exactly one of each signal is expected —
   * `afterEach` resets the harness between tests (below), so nothing here
   * needs to filter out a previous test's records.
   */
  function expectSignInRateLimitedTelemetry(): void {
    const logs = finishedLogRecords(harness.logExporter, 'auth.security.rate_limited');
    expect(logs, 'exactly one rate_limited log record').toHaveLength(1);
    const record = logs[0];
    expect(record?.severityNumber).toBe(SeverityNumber.WARN);
    expect(record?.attributes).toEqual({ [RATE_LIMIT_SCOPE_ATTRIBUTE]: 'sign_in' });

    const points = sumDataPoints(harness.metricExporter, 'tayzu.auth.rate_limit.events');
    expect(points, 'exactly one rate_limit.events counter increment').toHaveLength(1);
    expect(points[0]?.value).toBe(1);
    expect(points[0]?.attributes).toEqual({ [RATE_LIMIT_SCOPE_ATTRIBUTE]: 'sign_in' });
  }

  /**
   * A minimal, JSON-serializable snapshot of everything the harness has
   * captured so far (same rationale as `auth-flow.int.test.ts`'s identical
   * helper): every finished log record's `attributes`/`body`, and every
   * finished metric data point's `attributes`.
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
   * design D20: "Neither the caller's IP address nor their email appears
   * on either signal." Checked against everything the harness has
   * captured across the *whole* test (every ordinary-failure attempt too,
   * not only the breaching one), since `afterEach` only resets between
   * tests, not mid-test.
   */
  function expectNoSecretsInTelemetry(secrets: readonly string[]): void {
    const snapshot = serializedTelemetrySnapshot();
    for (const secret of secrets) {
      expect(snapshot, `telemetry must never contain ${JSON.stringify(secret)}`).not.toContain(
        secret,
      );
    }
  }

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    const options: RateLimitedCreateAuthOptions = {
      db,
      secret: TEST_SECRET,
      rateLimit: {
        signIn: {
          window: SIGN_IN_RATE_LIMIT_WINDOW_SECONDS,
          max: SIGN_IN_RATE_LIMIT_MAX,
        },
      },
    };
    auth = createAuth(options);
    harness = registeredHarness();
  }, 60_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  it('Repeated failed sign-ins from the same IP and email are rate-limited (spec scenario)', async () => {
    const handler = handlerOf(auth);
    const ip = randomIp();
    const email = randomEmail();

    for (let attemptIndex = 0; attemptIndex < SIGN_IN_RATE_LIMIT_MAX; attemptIndex += 1) {
      const response = await postSignIn(handler, { ip, email });
      expectOrdinaryFailure(response);
    }

    const blocked = await postSignIn(handler, { ip, email });
    await harness.forceFlush();

    await expectBlockedByRateLimit(blocked);
    expectSignInRateLimitedTelemetry();
    expectNoSecretsInTelemetry([ip, email]);
  });

  it('The sign-in limit is enforced per IP: the same IP with a different email each attempt is rate-limited', async () => {
    const handler = handlerOf(auth);
    const ip = randomIp();
    const emailsUsed: string[] = [];

    for (let attemptIndex = 0; attemptIndex < SIGN_IN_RATE_LIMIT_MAX; attemptIndex += 1) {
      const email = randomEmail();
      emailsUsed.push(email);
      const response = await postSignIn(handler, { ip, email });
      expectOrdinaryFailure(response);
    }

    const finalEmail = randomEmail();
    emailsUsed.push(finalEmail);
    const blocked = await postSignIn(handler, { ip, email: finalEmail });
    await harness.forceFlush();

    await expectBlockedByRateLimit(blocked);
    expectSignInRateLimitedTelemetry();
    expectNoSecretsInTelemetry([ip, ...emailsUsed]);
  });

  it('The sign-in limit is enforced per normalized email: case and whitespace variants of the same email, each from a different IP, are rate-limited', async () => {
    const handler = handlerOf(auth);
    const canonicalEmail = randomEmail();
    // Exactly SIGN_IN_RATE_LIMIT_MAX distinct-looking, all-valid case
    // variants of the same email, so the loop below consumes exactly the
    // configured limit before the breaching attempt.
    const caseVariants = [
      canonicalEmail.toLowerCase(),
      canonicalEmail.toUpperCase(),
      withAlternatingCase(canonicalEmail),
    ];
    expect(caseVariants, 'one case variant per allowed attempt').toHaveLength(
      SIGN_IN_RATE_LIMIT_MAX,
    );
    const ipsUsed: string[] = [];

    for (let attemptIndex = 0; attemptIndex < SIGN_IN_RATE_LIMIT_MAX; attemptIndex += 1) {
      const ip = randomIp();
      ipsUsed.push(ip);
      const variant = caseVariants[attemptIndex];
      if (variant === undefined) {
        throw new Error('caseVariants is shorter than SIGN_IN_RATE_LIMIT_MAX');
      }
      const response = await postSignIn(handler, { ip, email: variant });
      expectOrdinaryFailure(response);
    }

    // A whitespace-padded variant of the same email, from yet another
    // fresh IP: on the wire this would otherwise be rejected as an
    // invalid email (see module doc comment) -- a 429 here, not a 400,
    // is the proof that normalization (trim) grouped it into the same,
    // already-exhausted bucket.
    const paddedEmail = `  ${canonicalEmail.toLowerCase()}  `;
    const finalIp = randomIp();
    ipsUsed.push(finalIp);
    const blocked = await postSignIn(handler, { ip: finalIp, email: paddedEmail });
    await harness.forceFlush();

    await expectBlockedByRateLimit(blocked);
    expectSignInRateLimitedTelemetry();
    expectNoSecretsInTelemetry([...ipsUsed, ...caseVariants, paddedEmail]);
  });
});
