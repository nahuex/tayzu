/**
 * Integration test for task 22.1 (openspec/changes/002-auth-and-rbac; design
 * D26 "Back-channel logout", Resolved decisions Q16-Q21 and Q26-Q29;
 * `specs/auth-and-rbac/spec.md`, requirement "Back-channel logout from Visma
 * Connect revokes the matching sessions").
 *
 * Scenario covered (verbatim from the spec):
 *
 * - "An invalid signature is rejected without revealing session existence":
 *   GIVEN a logout token with an invalid signature, WHEN it is received, THEN
 *   it is rejected, and the response is identical in shape to a valid token
 *   naming a session that does not exist.
 *
 * Tests never call the real Visma Connect: the local OIDC stub (task 19.1)
 * serves discovery and the JWKS, and its `signJwt` mints the tokens (a
 * validly-signed one and tampered ones). Cerbos is not consulted by this route.
 *
 * ## Production symbols expected (the red phase)
 *
 * - `POST /v1/auth/visma-connect/backchannel-logout` on the `createApp`
 *   Fastify instance (`./server.js`), public (no session cookie, no CSRF
 *   header: Visma Connect's infrastructure is the caller), body
 *   `application/x-www-form-urlencoded` with the single `logout_token` field.
 *   It is outside `/api/auth/*`, so it is not in the D18 allowlist.
 * - The token is verified against the JWKS from the discovery document behind
 *   `options.sso.discoveryUrl`, with `typ: logout+jwt`, `iss` = discovered
 *   issuer, `aud` = `options.sso.clientId`, `events`, no `nonce`, and `jti`.
 *   The stub's `signJwt` fixes the header `typ` to `JWT`, so the control token
 *   below is validly signed but not `logout+jwt`; a correct implementation
 *   rejects it at the `typ` step, which D26 makes indistinguishable from a
 *   processed token anyway (same 200, same body). The stub cannot mint a
 *   fully spec-valid token without a fixture change (a later task's concern).
 * - Per D26 the response never reveals anything: a rejected token (invalid
 *   signature) and a token naming a session that does not exist both answer
 *   HTTP 200 with the same body. A missing `logout_token` is a generic 4xx
 *   (not asserted here).
 * - An invalid-signature token revokes nothing: a session whose `sso_sid`
 *   equals the tampered token's `sid` survives.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (design D1): the telemetry harness must register
// before anything that loads `@tayzu/auth`, so this import stays first.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import {
  bootstrapTestTenant,
  signInAdminUser,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';
import type { Pool } from 'pg';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

const TEST_PASSWORD = 'correct horse battery staple';
const ROUTE = '/v1/auth/visma-connect/backchannel-logout';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('apps/api back-channel logout (task 22.1, design D26)', () => {
  let app: App;
  let stub: OidcStub;
  let authPool: Pool;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    stub = await startOidcStub();
    app = await createApp({
      appPool: pools.appPool,
      authPool: pools.authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: ['https://app.tayzu.test'],
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  });

  function logoutClaims(sid: string): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: stub.issuer,
      aud: stub.clientId,
      sub: `bcl-sub-${randomUUID()}`,
      sid,
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
      events: { [LOGOUT_EVENT]: {} },
    };
  }

  function postLogout(logoutToken: string) {
    return app.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': randomIp(),
      },
      payload: new URLSearchParams({ logout_token: logoutToken }).toString(),
    });
  }

  /** Flips one payload claim while keeping the original signature: the signature no longer verifies. */
  function tamperPayload(token: string, patch: Record<string, unknown>): string {
    const [head, body, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(JSON.stringify({ ...claims, ...patch })).toString('base64url');
    return `${head ?? ''}.${forged}.${signature ?? ''}`;
  }

  /** A session established "through Visma Connect": a real session row carrying `sso_sid`. */
  async function ssoSession(sid: string): Promise<string> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Backchannel Logout',
      email: `bcl-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Backchannel Org ${suffix}`,
      organizationSlug: `bcl-org-${suffix}`,
      ip: randomIp(),
    });
    await authPool.query('update auth.session set sso_sid = $1 where user_id = $2', [
      sid,
      tenant.userId,
    ]);
    return tenant.userId;
  }

  async function sessionCount(userId: string): Promise<number> {
    const result = await authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.session where user_id = $1',
      [userId],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  it('An invalid signature is rejected without revealing session existence: a tampered token and a validly-signed token for an unknown session get the same response, and nothing is revoked', async () => {
    const sid = `sid-${randomUUID()}`;
    const userId = await ssoSession(sid);
    const before = await sessionCount(userId);
    expect(before, 'the SSO session exists before the logout attempts').toBeGreaterThan(0);

    // Validly signed with the stub's key (the JWKS key), naming a session that does not exist.
    // Limitation: `signJwt` fixes the header `typ` to `JWT`, so a fully spec-valid
    // `logout+jwt` control is not mintable with the stub as it is; the response
    // shape for the control is asserted against the same 200 the design
    // mandates for every processed-or-not case.
    const unknownSessionToken = stub.signJwt(logoutClaims(`sid-missing-${randomUUID()}`));
    const unknownSession = await postLogout(unknownSessionToken);

    // Tampered: a genuine token whose payload names the real session's sid but
    // whose signature was made over different claims.
    const genuine = stub.signJwt(logoutClaims(`sid-other-${randomUUID()}`));
    const tampered = await postLogout(tamperPayload(genuine, { sid }));

    // Also tampered: signature bytes replaced outright.
    const [head, body] = genuine.split('.');
    const garbledSignature = await postLogout(
      `${head ?? ''}.${body ?? ''}.${Buffer.from(randomUUID()).toString('base64url')}`,
    );

    // Rejected, yet indistinguishable from "valid token, no such session".
    expect(unknownSession.statusCode, 'the endpoint exists and answers 200').toBe(200);
    expect(tampered.statusCode).toBe(unknownSession.statusCode);
    expect(garbledSignature.statusCode).toBe(unknownSession.statusCode);
    expect(tampered.body).toBe(unknownSession.body);
    expect(garbledSignature.body).toBe(unknownSession.body);
    expect(tampered.headers['content-type']).toBe(unknownSession.headers['content-type']);
    expect(garbledSignature.headers['content-type']).toBe(unknownSession.headers['content-type']);

    // And the rejected token revoked nothing.
    expect(await sessionCount(userId), 'the tampered token did not revoke the session').toBe(
      before,
    );
  });

  /**
   * Task 22.2 (design D26, "Where `jti` replay state lives"), scenario "A replayed
   * logout token is rejected without revealing anything twice": GIVEN a logout
   * token already processed once, WHEN the same token is received again, THEN it
   * is rejected as a replay and no further session state changes.
   *
   * Production symbols expected: the route records one `auth.verification` row per
   * accepted token (`identifier = "backchannel-logout:{aud}:{jti}"`, `expires_at`
   * bounded by the token's `exp` plus the 30s skew) and, on a second delivery,
   * answers the same 200 without touching sessions. No new table.
   */
  it('A replayed logout token is rejected without revoking anything twice', async () => {
    const sid = `sid-${randomUUID()}`;
    const firstUserId = await ssoSession(sid);
    const claims = logoutClaims(sid);
    const jti = claims['jti'] as string;
    const exp = claims['exp'] as number;
    const token = stub.signJwt(claims, { typ: 'logout+jwt' });

    const first = await postLogout(token);
    expect(first.statusCode).toBe(200);
    expect(await sessionCount(firstUserId), 'first delivery revokes the matching session').toBe(0);

    // The token is recorded in the existing verification table, bounded by exp + skew.
    const identifier = `backchannel-logout:${stub.clientId}:${jti}`;
    const recorded = await authPool.query<{ expires_at: Date }>(
      'select expires_at from auth.verification where identifier = $1',
      [identifier],
    );
    expect(recorded.rows, 'exactly one replay record for the accepted token').toHaveLength(1);
    const expiresAtSeconds = (recorded.rows[0]?.expires_at.getTime() ?? 0) / 1000;
    expect(expiresAtSeconds).toBeGreaterThanOrEqual(exp);
    expect(expiresAtSeconds).toBeLessThanOrEqual(exp + 30 + 5);

    // A new session with the same Visma Connect sid appears after the first delivery;
    // a replay must not revoke it ("no further session state changes").
    const secondUserId = await ssoSession(sid);
    const secondBefore = await sessionCount(secondUserId);
    expect(secondBefore).toBeGreaterThan(0);

    const replay = await postLogout(token);
    expect(replay.statusCode, 'a replay answers like every other outcome').toBe(200);
    expect(replay.body).toBe(first.body);
    expect(replay.headers['content-type']).toBe(first.headers['content-type']);
    expect(await sessionCount(secondUserId), 'the replay revoked nothing').toBe(secondBefore);

    const afterReplay = await authPool.query(
      'select 1 from auth.verification where identifier = $1',
      [identifier],
    );
    expect(afterReplay.rows, 'the replay record is not duplicated').toHaveLength(1);
  });

  /**
   * Task 22.3 (design D26, "Session matching and revocation"), scenario "A valid
   * logout token revokes the matching session": GIVEN an active Tayzu session
   * established through Visma Connect, WHEN a valid back-channel logout token
   * naming that session's Visma Connect session id is received, THEN that session
   * fails exactly as `CATALOG_CONTEXT_REQUIRED` on its next use.
   *
   * Production symbols expected: the route revokes every `auth.session` whose
   * `sso_sid` equals the verified token's `sid`; when the token has no `sid`, it
   * revokes the `sso_sid`-not-null sessions of the user linked through
   * `auth.account` (`provider_id = 'visma-connect'`, `account_id = sub`). A
   * same-user local session (`sso_sid` null) is never revoked.
   */
  async function signedInTenant(): Promise<{ userId: string; cookie: string; token: string }> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Backchannel Revocation',
      email: `bcl-rev-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Backchannel Rev Org ${suffix}`,
      organizationSlug: `bcl-rev-${suffix}`,
      ip: randomIp(),
    });
    return { userId: tenant.userId, cookie: tenant.cookie, token: tenant.token };
  }

  async function markSso(token: string, sid: string): Promise<void> {
    const result = await authPool.query('update auth.session set sso_sid = $1 where token = $2', [
      sid,
      token,
    ]);
    expect(result.rowCount, 'the session row to mark as SSO-established exists').toBe(1);
  }

  async function localSession(userId: string, email: string): Promise<string> {
    const signedIn = await signInAdminUser(app.auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    expect(signedIn.userId).toBe(userId);
    return signedIn.cookie;
  }

  function useSession(cookie: string) {
    return app.app.inject({ method: 'GET', url: '/v1/blueprints', headers: { cookie } });
  }

  it('A valid logout token revokes the matching session: the SSO session fails as CATALOG_CONTEXT_REQUIRED afterward while a same-user local session remains valid', async () => {
    const sso = await signedInTenant();
    const sid = `sid-${randomUUID()}`;
    await markSso(sso.token, sid);
    const email = (
      await authPool.query<{ email: string }>('select email from auth."user" where id = $1', [
        sso.userId,
      ])
    ).rows[0]?.email;
    const localCookie = await localSession(sso.userId, email ?? '');
    expect((await useSession(sso.cookie)).statusCode, 'SSO session works before').toBe(200);
    expect((await useSession(localCookie)).statusCode, 'local session works before').toBe(200);

    // A bystander user's SSO session with a different sid must also survive.
    const other = await signedInTenant();
    await markSso(other.token, `sid-other-${randomUUID()}`);

    const response = await postLogout(stub.signJwt(logoutClaims(sid), { typ: 'logout+jwt' }));
    expect(response.statusCode).toBe(200);

    const revoked = await useSession(sso.cookie);
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json<{ code: string }>().code).toBe('CATALOG_CONTEXT_REQUIRED');
    expect((await useSession(localCookie)).statusCode, 'the local session remains valid').toBe(200);
    expect((await useSession(other.cookie)).statusCode, 'a non-matching sid survives').toBe(200);
  }, 60_000);

  it('A valid logout token without sid revokes by sub only the linked user’s Visma Connect sessions, never their local sessions', async () => {
    const sso = await signedInTenant();
    const email = (
      await authPool.query<{ email: string }>('select email from auth."user" where id = $1', [
        sso.userId,
      ])
    ).rows[0]?.email;
    const sub = `bcl-sub-${randomUUID()}`;
    await authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, 'visma-connect', $3, now(), now())`,
      [randomUUID(), sub, sso.userId],
    );
    await markSso(sso.token, `sid-${randomUUID()}`);
    const localCookie = await localSession(sso.userId, email ?? '');
    const other = await signedInTenant();
    await markSso(other.token, `sid-other-${randomUUID()}`);

    // A logout token that names only the user (no sid claim).
    const claims: Record<string, unknown> = { ...logoutClaims('unused') };
    Reflect.deleteProperty(claims, 'sid');
    const response = await postLogout(stub.signJwt({ ...claims, sub }, { typ: 'logout+jwt' }));
    expect(response.statusCode).toBe(200);

    const revoked = await useSession(sso.cookie);
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json<{ code: string }>().code).toBe('CATALOG_CONTEXT_REQUIRED');
    expect((await useSession(localCookie)).statusCode, 'the local session remains valid').toBe(200);
    expect((await useSession(other.cookie)).statusCode, 'another user is untouched').toBe(200);
  }, 60_000);

  /**
   * Task 22.4 (design D26 "Rate limiting and information exposure"; "Observability
   * contract": span `auth.backchannel_logout.received`, counter
   * `tayzu.auth.backchannel_logout.events`).
   *
   * Production symbols expected: every request to the route (whatever its outcome)
   * answers the identical 200 (status, body, content type); it emits one
   * `auth.backchannel_logout.received` span and one
   * `tayzu.auth.backchannel_logout.events` increment, both carrying only the closed
   * `tayzu.auth.backchannel_logout.outcome` attribute (`revoked` | `replay` |
   * `invalid` | `no_match`), and no `sub`/`sid`/token/email/IP anywhere on them.
   * The `@fastify/rate-limit` IP-keyed floor has no option name in the design, so
   * it is not asserted here.
   */
  const SPAN_NAME = 'auth.backchannel_logout.received';
  const COUNTER_NAME = 'tayzu.auth.backchannel_logout.events';
  const OUTCOME_ATTRIBUTE = 'tayzu.auth.backchannel_logout.outcome';
  const METRIC_DATA_POINT_TYPE_SUM = 3;

  function harnessOrThrow(): TelemetryTestHarness {
    if (!('harness' in registration)) {
      throw new Error(`telemetry harness failed to register: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    return registration.harness;
  }

  function postLogoutFrom(logoutToken: string, ip: string) {
    return app.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
      payload: new URLSearchParams({ logout_token: logoutToken }).toString(),
    });
  }

  function comparableHeaders(headers: Record<string, unknown>): string[] {
    return Object.keys(headers)
      .filter(
        (name) => name !== 'date' && !name.startsWith('x-ratelimit') && name !== 'retry-after',
      )
      .sort();
  }

  it('Every outcome returns the identical 200 shape and emits the span and counter with only the closed outcome attribute', async () => {
    const harness = harnessOrThrow();
    const ip = randomIp();
    const revokedSid = `sid-${randomUUID()}`;
    await ssoSession(revokedSid);
    const revokedToken = stub.signJwt(logoutClaims(revokedSid), { typ: 'logout+jwt' });
    const invalidToken = tamperPayload(
      stub.signJwt(logoutClaims(`sid-x-${randomUUID()}`), { typ: 'logout+jwt' }),
      { sid: `sid-y-${randomUUID()}` },
    );
    const noMatchClaims = logoutClaims(`sid-missing-${randomUUID()}`);
    const noMatchToken = stub.signJwt(noMatchClaims, { typ: 'logout+jwt' });

    await harness.reset();

    const revoked = await postLogoutFrom(revokedToken, ip);
    const replay = await postLogoutFrom(revokedToken, ip);
    const invalid = await postLogoutFrom(invalidToken, ip);
    const noMatch = await postLogoutFrom(noMatchToken, ip);

    for (const response of [revoked, replay, invalid, noMatch]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(revoked.body);
      expect(response.headers['content-type']).toBe(revoked.headers['content-type']);
      expect(comparableHeaders(response.headers)).toEqual(comparableHeaders(revoked.headers));
    }

    await harness.forceFlush();

    // Span: one per request, one per outcome, only the closed outcome attribute.
    const spans = harness.spanExporter.getFinishedSpans().filter((span) => span.name === SPAN_NAME);
    expect(spans, 'one span per request').toHaveLength(4);
    expect(spans.map((span) => span.attributes[OUTCOME_ATTRIBUTE]).sort()).toEqual([
      'invalid',
      'no_match',
      'replay',
      'revoked',
    ]);
    for (const span of spans) {
      expect(Object.keys(span.attributes)).toEqual([OUTCOME_ATTRIBUTE]);
    }

    // Counter: one increment per outcome, only the closed outcome attribute.
    const points: { outcome: unknown; value: number; keys: string[] }[] = [];
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (
            metric.descriptor.name === COUNTER_NAME &&
            // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
            metric.dataPointType === METRIC_DATA_POINT_TYPE_SUM
          ) {
            for (const point of metric.dataPoints) {
              points.push({
                outcome: point.attributes[OUTCOME_ATTRIBUTE],
                value: point.value,
                keys: Object.keys(point.attributes),
              });
            }
          }
        }
      }
    }
    for (const outcome of ['revoked', 'replay', 'invalid', 'no_match']) {
      const total = points
        .filter((point) => point.outcome === outcome)
        .reduce((sum, point) => sum + point.value, 0);
      expect(total, `counter total for ${outcome}`).toBe(1);
    }
    for (const point of points) {
      expect(point.keys).toEqual([OUTCOME_ATTRIBUTE]);
    }

    // No sub / sid / token / email / IP on either signal.
    const serialized = JSON.stringify({
      spans: spans.map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
      points,
    });
    for (const secret of [
      revokedSid,
      String(noMatchClaims['sub']),
      String(noMatchClaims['sid']),
      revokedToken,
      invalidToken,
      noMatchToken,
      ip,
      '@example.test',
    ]) {
      expect(serialized, 'no sensitive value in the span or counter').not.toContain(secret);
    }
  }, 60_000);
});
