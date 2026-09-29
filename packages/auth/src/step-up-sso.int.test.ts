/**
 * Integration test for task 21.3 (design D25, resolved decision Q19;
 * `specs/auth-and-rbac/spec.md`, "Step-up authentication for high-risk
 * operations").
 *
 * #### Scenario: A fresh Visma Connect re-authorization with an MFA method satisfies step-up
 * - GIVEN a user whose session was established through Visma Connect,
 *   re-authorizing with an MFA method within the freshness threshold
 * - WHEN they call `blueprints.delete`
 * - THEN the deletion proceeds
 *
 * #### Scenario: A Visma Connect re-authorization without a qualifying MFA claim does not satisfy step-up
 * - GIVEN a user whose session was established through Visma Connect,
 *   completing a re-authorization whose returned claims do not include a
 *   qualifying MFA method or authentication context level
 * - WHEN they call `blueprints.delete`
 * - THEN it fails with `AUTH_STEP_UP_REQUIRED` and the blueprint is not deleted
 *
 * plus the `auth.security.step_up_insufficient` event of the task's Verify
 * clause (design "Log events": WARN; `tayzu.tenant.id`, `tayzu.actor.id`,
 * `tayzu.auth.method` = `visma_connect`).
 *
 * ## Assumed production surface (the red phase)
 *
 * Design D25 fixes the checks (`auth_time` within 300s +- 30s skew, `acr >= 3`,
 * `amr` containing an accepted MFA method, ID token signature verified) but
 * not how the returned ID token reaches the guard. This file assumes:
 *
 * - `createStepUpGuard({ auth, sso })`: `sso` is the same
 *   `{ discoveryUrl, clientId, clientSecret }` `createAuth` takes; the guard
 *   uses it to verify the returned ID token (signature via the discovered
 *   JWKS, `iss`, `aud`).
 * - `AssertStepUpParams.reauthorization?: { readonly idToken: string }`: the
 *   raw ID token the host's re-authorization callback received. The guard
 *   never trusts that the redirect parameters survived the browser: it
 *   validates this token only.
 * - A session row with `sso_sid` set selects the Visma Connect branch; `null`
 *   keeps the local `twoFactorVerifiedAt` check (covered by
 *   `step-up.int.test.ts`, unchanged). `actor.type` is never consulted for
 *   the branch beyond the existing `user` gate.
 * - The `auth.session.step_up_check` span carries `tayzu.auth.method` =
 *   `visma_connect` on this branch (design "Spans").
 *
 * If the implementation settles on a different way to hand the token to the
 * guard, only `reauthorize()` below changes.
 *
 * Tests never call the real Visma Connect: the task-19.1 OIDC stub signs the
 * tokens.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { SeverityNumber } from '@opentelemetry/api-logs';
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Import order is load-bearing (design D1): the harness registers first.
import { bootstrapTestTenant } from './__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from './__fixtures__/oidc-stub.js';
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
import * as authSchema from './persistence/schema.js';
import { createStepUpGuard } from './step-up.js';
import type { AssertStepUpParams, StepUpGuard } from './step-up.js';

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
    // Expected only during teardown.
  });
  await closeable.end();
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';
const HIGH_RISK_ROUTE = { riskLevel: 'high' } as const;
const BLUEPRINT_DELETE_OPERATION = 'blueprint.delete';

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
}

describe('Step-up for a Visma-Connect-established session (task 21.3, design D25)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let stub: OidcStub;
  let guard: StepUpGuard;
  let harness: TelemetryTestHarness;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    stub = await startOidcStub();
    const sso = {
      discoveryUrl: stub.discoveryUrl,
      clientId: stub.clientId,
      clientSecret: stub.clientSecret,
    };
    auth = createAuth({ db, secret: TEST_SECRET, sso });
    guard = createStepUpGuard({ auth, sso });
    harness = registeredHarness();
  }, 60_000);

  afterAll(async () => {
    await stub.close();
    await endQuietly(db.$client);
  });

  /** A user whose current session was established through Visma Connect (`sso_sid` set). */
  async function ssoSessionUser(): Promise<{
    cookie: string;
    userId: string;
    organizationId: string;
    sid: string;
  }> {
    const tenant = await bootstrapTestTenant(auth, {
      name: 'Sso Step-Up User',
      email: `sso-step-up-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Sso Step-Up Org',
      organizationSlug: `sso-step-up-${randomUUID()}`,
      ip: randomIp(),
    });
    const sid = `sid-${randomUUID()}`;
    await db.execute(
      sql`update auth.session set sso_sid = ${sid} where user_id = ${tenant.userId}`,
    );
    return { ...tenant, sid };
  }

  /** The ID token a Visma Connect re-authorization callback returns, signed by the stub. */
  function reauthIdToken(user: { sid: string }, claims: Record<string, unknown>): string {
    const now = Math.floor(Date.now() / 1000);
    return stub.signJwt({
      iss: stub.issuer,
      aud: stub.clientId,
      sub: `sub-${randomUUID()}`,
      sid: user.sid,
      iat: now,
      exp: now + 300,
      auth_time: now,
      ...claims,
    });
  }

  async function run(
    user: { cookie: string; userId: string; organizationId: string },
    idToken: string,
  ): Promise<{ handler: ReturnType<typeof vi.fn>; outcome: Promise<void> }> {
    const handler = vi.fn();
    const params: AssertStepUpParams = {
      headers: new Headers({ cookie: user.cookie }),
      tenantId: user.organizationId,
      actor: { type: 'user', id: user.userId },
      route: HIGH_RISK_ROUTE,
      operation: BLUEPRINT_DELETE_OPERATION,
      reauthorization: { idToken },
    };
    const outcome = (async () => {
      await guard(params);
      handler();
    })();
    return { handler, outcome };
  }

  function insufficientEvents(): ReturnType<
    TelemetryTestHarness['logExporter']['getFinishedLogRecords']
  > {
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === 'auth.security.step_up_insufficient',
    );
  }

  it('A fresh Visma Connect re-authorization with an MFA method satisfies step-up', async () => {
    const user = await ssoSessionUser();
    await harness.reset();

    const now = Math.floor(Date.now() / 1000);
    const { handler, outcome } = await run(
      user,
      reauthIdToken(user, { auth_time: now - 10, acr: 3, amr: ['pwd', 'otp'] }),
    );
    await outcome;
    expect(handler, 'the deletion proceeds').toHaveBeenCalledTimes(1);

    await harness.forceFlush();
    expect(insufficientEvents(), 'no insufficient event on success').toHaveLength(0);
    const spans = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.name === 'auth.session.step_up_check');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes).toEqual({
      'tayzu.auth.method': 'visma_connect',
      'tayzu.auth.step_up.fresh': true,
    });
  });

  it('A Visma Connect re-authorization without a qualifying MFA claim does not satisfy step-up: AUTH_STEP_UP_REQUIRED, deletion not performed, step_up_insufficient logged', async () => {
    const user = await ssoSessionUser();
    await harness.reset();

    // Fresh, but the returned claims carry only a password method and LoA 2.
    const { handler, outcome } = await run(user, reauthIdToken(user, { acr: 2, amr: ['pwd'] }));
    await expect(outcome).rejects.toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' });
    expect(handler, 'the deletion never runs').not.toHaveBeenCalled();

    await harness.forceFlush();
    const events = insufficientEvents();
    expect(events, 'exactly one step_up_insufficient event').toHaveLength(1);
    expect(events[0]?.severityNumber).toBe(SeverityNumber.WARN);
    expect(events[0]?.attributes).toEqual({
      'tayzu.tenant.id': user.organizationId,
      'tayzu.actor.id': user.userId,
      'tayzu.auth.method': 'visma_connect',
    });
    const spans = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.name === 'auth.session.step_up_check');
    expect(spans[0]?.attributes).toMatchObject({
      'tayzu.auth.method': 'visma_connect',
      'tayzu.auth.step_up.fresh': false,
    });
  });

  it.each([
    ['a stale auth_time (older than 300s + 30s skew)', { acr: 3, amr: ['otp'], stale: true }],
    ['an acr below 3', { acr: 2, amr: ['otp'] }],
    ['no accepted MFA method in amr', { acr: 3, amr: ['pwd'] }],
    ['no amr at all', { acr: 3 }],
  ] as const)('does not satisfy step-up with %s', async (_label, spec) => {
    const user = await ssoSessionUser();
    await harness.reset();
    const { stale, ...claims } = spec as { stale?: boolean } & Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    const { handler, outcome } = await run(
      user,
      reauthIdToken(user, { ...claims, ...(stale === true ? { auth_time: now - 600 } : {}) }),
    );
    await expect(outcome).rejects.toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' });
    expect(handler).not.toHaveBeenCalled();
    await harness.forceFlush();
    expect(insufficientEvents()).toHaveLength(1);
  });

  it('does not trust an ID token that was not signed by the discovered Visma Connect keys', async () => {
    const user = await ssoSessionUser();
    await harness.reset();
    const other = await startOidcStub();
    try {
      const now = Math.floor(Date.now() / 1000);
      const forged = other.signJwt({
        iss: stub.issuer,
        aud: stub.clientId,
        sub: 'x',
        sid: user.sid,
        iat: now,
        exp: now + 300,
        auth_time: now,
        acr: 3,
        amr: ['otp'],
      });
      const { handler, outcome } = await run(user, forged);
      await expect(outcome).rejects.toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await other.close();
    }
  });
});
