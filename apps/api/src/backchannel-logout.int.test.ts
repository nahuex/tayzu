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

import { bootstrapTestTenant } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';
import type { Pool } from 'pg';

const TEST_SECRET = 'api-int-test-only-secret-not-used-for-anything-real-0123456789';
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
});
