/**
 * Integration test for task 14.16 (Resolved decision Q138; design D13 machine
 * branch, Q40), over the HTTP route `POST /v1/auth/token`.
 *
 * Scenarios (specs/identity-lifecycle-and-org-admin/spec.md):
 *
 * - "Disabling a service account takes effect within seconds": a new exchange is
 *   refused.
 * - "Re-enabling restores access without a new credential": the `Disabled`
 *   account's status becomes `Active` and the same credential exchanges a token
 *   again.
 * - Requirement: no token is issued for a service account whose bound `_user` is
 *   absent or not `Active`, so a surviving credential of a deleted service
 *   account never resolves.
 *
 * ## Production symbols expected
 *
 * - `@tayzu/auth` exports `createServiceAccountLookup(pool)` (module
 *   `packages/auth/src/service-account-lookup.ts`), a
 *   `ExchangeMachineTokenPorts['serviceAccountLookup']` over a `tayzu_app` pool.
 * - `apps/api/src/server.ts` passes it to `exchangeMachineToken` as the third
 *   argument, built over the injected `appPool`.
 *
 * The test goes only through the route, so it does not import those symbols.
 *
 * ## Why this fails right now
 *
 * `server.ts` calls `exchangeMachineToken(auth, { ... })` with no ports, so the
 * `_user` row is never consulted and a Disabled / deleted service account's
 * credential still receives a token (HTTP 200).
 */
import { randomInt, randomUUID } from 'node:crypto';

import { withTenantTransaction } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  seedUserRow,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { createMachineCredential } from '../../../packages/auth/src/machine-credentials.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const TEST_PASSWORD = 'correct horse battery staple';
const ALLOWED_ORIGIN = 'https://app.tayzu.test';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('apps/api POST /v1/auth/token service-account lookup (task 14.16)', () => {
  let app: App;

  beforeAll(async () => {
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  function exchange(credential: { id: string; secret: string }) {
    return app.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: {
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({ clientId: credential.id, clientSecret: credential.secret }),
    });
  }

  async function serviceAccount(status: 'Active' | 'Disabled') {
    const suffix = randomUUID();
    const admin = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Token Exchange Http',
      email: `token-exchange-http-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Token Exchange Http Org ${suffix}`,
      organizationSlug: `token-exchange-http-org-${suffix}`,
      ip: randomIp(),
    });
    const serviceAccountId = `svc-${suffix.slice(0, 8)}`;
    await seedUserRow(testAppPool(), {
      tenantId: admin.organizationId,
      email: serviceAccountId,
      name: serviceAccountId,
      status,
    });
    const credential = await createMachineCredential(app.auth, {
      userId: admin.userId,
      organizationId: admin.organizationId,
      name: 'Service account credential',
      actorKind: 'integration',
      metadata: { userId: serviceAccountId, createdBy: admin.userId },
    });
    return { tenantId: admin.organizationId, serviceAccountId, credential };
  }

  async function setStatus(
    tenantId: string,
    identifier: string,
    status: 'Active' | 'Disabled',
  ): Promise<void> {
    await withTenantTransaction(testAppPool(), { tenantId }, async (client) => {
      const written = await client.query(
        `update catalog_entity
            set spec_properties = jsonb_set(spec_properties, '{status}', to_jsonb($3::text))
          where tenant_id = $1 and identifier = $2`,
        [tenantId, identifier, status],
      );
      expect(written.rowCount, 'sanity: the _user row exists').toBe(1);
    });
  }

  /** The reference answer: a wrong secret for a real client id. */
  async function invalidCredentialAnswer(credential: { id: string; secret: string }) {
    const response = await exchange({ id: credential.id, secret: `wrong-${randomUUID()}` });
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
  }

  function expectLikeInvalid(
    response: Awaited<ReturnType<typeof exchange>>,
    reference: { status: number; body: Record<string, unknown> },
  ): void {
    expect(response.statusCode).toBe(reference.status);
    const body = response.json<Record<string, unknown>>();
    expect(body['code']).toBe('AUTH_INVALID_CREDENTIALS');
    expect(body).toEqual(reference.body);
    expect(body).not.toHaveProperty('accessToken');
    expect(response.body).not.toMatch(/eyJ[\w-]+\.[\w-]+\./);
  }

  it('A Disabled service account answers like an invalid credential, with no token', async () => {
    const sa = await serviceAccount('Disabled');
    const reference = await invalidCredentialAnswer(sa.credential);
    expect(reference.body['code']).toBe('AUTH_INVALID_CREDENTIALS');

    expectLikeInvalid(await exchange(sa.credential), reference);
  }, 60_000);

  it('A service account whose _user row was deleted answers like an invalid credential, with no token', async () => {
    const sa = await serviceAccount('Active');
    const reference = await invalidCredentialAnswer(sa.credential);

    // Sanity: while the `_user` is Active the credential exchanges.
    const before = await exchange(sa.credential);
    expect(before.statusCode).toBe(200);
    expect(typeof before.json<{ accessToken?: unknown }>().accessToken).toBe('string');

    await withTenantTransaction(testAppPool(), { tenantId: sa.tenantId }, async (client) => {
      const removed = await client.query(
        `delete from catalog_entity where tenant_id = $1 and identifier = $2`,
        [sa.tenantId, sa.serviceAccountId],
      );
      expect(removed.rowCount, 'sanity: the _user row was removed').toBe(1);
    });

    expectLikeInvalid(await exchange(sa.credential), reference);
  }, 60_000);

  it('Re-enabling restores access without a new credential', async () => {
    const sa = await serviceAccount('Disabled');
    const reference = await invalidCredentialAnswer(sa.credential);

    // GIVEN a Disabled service account: refused.
    expectLikeInvalid(await exchange(sa.credential), reference);

    // WHEN it is re-enabled.
    await setStatus(sa.tenantId, sa.serviceAccountId, 'Active');

    // THEN the same credential receives a token again.
    const after = await exchange(sa.credential);
    expect(after.statusCode).toBe(200);
    const token = after.json<{ accessToken?: unknown }>().accessToken;
    expect(typeof token).toBe('string');
    const claims = JSON.parse(
      Buffer.from((token as string).split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(claims['userId']).toBe(sa.serviceAccountId);
    expect(claims['tenantId']).toBe(sa.tenantId);
  }, 60_000);
});
