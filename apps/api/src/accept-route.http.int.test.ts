/**
 * Task 14.1b of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * "Invitation acceptance"; design D4 "Acceptance", D10, Resolved decisions Q8,
 * Q18 and Q24).
 *
 * Task 14.1b Verify: "`accept-route.http.int.test.ts` covers "A new person
 * accepts and can then sign in" over HTTP, without a session, and the route
 * being absent from the OpenAPI document and from the `contract:check` input."
 *
 * Scenario (verbatim from the spec): "A new person accepts and can then sign in".
 * - GIVEN a pending invitation to `bob@example.com`, who has no account
 * - WHEN `bob` presents the invitation id, the token and a policy-compliant
 *   password
 * - THEN `bob` has an account with a verified email, a membership with the
 *   invited role and status `Active`, and no session exists
 * - AND the invitation is `accepted` and the token cannot be used a second time
 *
 * ## Harness
 *
 * The real server (`createApp`, injected requests, never a listener). The
 * invitation is created in process through the identity router over the app's
 * own Better Auth instance (the tenant is a fresh organization per test); the
 * token is read from the recording sender's email. The acceptance itself and the
 * sign-in are HTTP requests, each with a fresh random `x-forwarded-for`.
 *
 * ## Production symbols expected
 *
 * - `createApp` (`./server.js`) registers `POST /v1/auth/invitations/accept` as a
 *   plain Fastify route before the `/v1/*` catch-all, with no option required.
 *   Its body is `{ invitationId, token, password }`; it creates no session (no
 *   `set-cookie`), answers 2xx with the new person's acceptance, and rejects a
 *   second use of the token with the uniform 404 of the rejected acceptance.
 * - The route is in neither `openapi/identity.openapi.json` nor the generated
 *   document of `./identity-openapi.js`.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRouterClient } from '@orpc/server';
import { createRecordingEmailSender } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createEmailTenantGate } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { createWithUserLock } from './identity/user-lock.js';
import { checkIdentityContract, generateIdentityOpenApiDocument } from './identity-openapi.js';
import { createIdentityRouter } from './identity-router.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const LINK_BASE_URL = 'https://app.tayzu.test';
const ACCEPT_PATH = '/v1/auth/invitations/accept';
const ACCEPT_PASSWORD = 'Café-Mañana-Passäphrase-2026!';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('POST /v1/auth/invitations/accept over HTTP (task 14.1b, design D4, Q8, Q18, Q24)', () => {
  let app: App;
  let pools: HarnessPools;
  let sender: ReturnType<typeof createRecordingEmailSender>;
  let userSync: ReturnType<typeof createUserSync>;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    pools = await harnessPools();
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      // Task 14.3: the routes are off by default; this file exercises the accept route.
      ...{ mountIdentityRoutes: true },
    });
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    sender = createRecordingEmailSender();
    client = createRouterClient(
      createIdentityRouter({
        auth: app.auth,
        authz: cerbos,
        authRepository: createAuthRepository(pools.authPool),
        withUserLock: createWithUserLock(pools.authPool),
        emailGate: createEmailTenantGate({
          disabledTenantIds: [],
          capStore: createInMemoryEmailCapStore({
            tenant: { max: 1000, windowSeconds: 3600 },
            recipient: { max: 1000, windowSeconds: 86_400 },
          }),
          sender,
        }),
        invitationLinkBaseUrl: LINK_BASE_URL,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  /** A pending invitation to a fresh address, with the token from its email. */
  async function pendingInvitation(role: 'member' | 'admin' = 'member'): Promise<{
    tenantId: string;
    email: string;
    invitationId: string;
    token: string;
  }> {
    const id = randomUUID();
    const admin = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Accept Admin',
      email: `accept-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Accept Org',
      organizationSlug: `accept-${id}`,
      ip: randomIp(),
    });
    const headers = new Headers({ cookie: admin.cookie, 'x-forwarded-for': randomIp() });
    const email = `bob-${randomUUID()}@example.test`;
    const created = await client.identity.users.invite(
      { body: { email, role } },
      {
        context: {
          tenantId: admin.organizationId,
          actor: { type: 'user', id: admin.userId },
          principal: { roles: ['admin'] },
          __requestHeaders: headers,
          __stepUpHeaders: headers,
        },
      },
    );
    const template = sender.sent.find((message) => message.to === email)?.template;
    if (template?.kind !== 'InvitationEmail') throw new Error('the invitation email was not sent');
    const token = new URLSearchParams(new URL(template.link).hash.slice(1)).get('token') ?? '';
    expect(token.length).toBeGreaterThan(0);
    return { tenantId: admin.organizationId, email, invitationId: created.invitationId, token };
  }

  function accept(body: Record<string, unknown>) {
    return app.app.inject({
      method: 'POST',
      url: ACCEPT_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify(body),
    });
  }

  function signIn(email: string, password: string) {
    return app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        host: 'localhost:3000',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify({ email, password }),
    });
  }

  it('A new person accepts and can then sign in: an account with a verified email, an Active membership with the invited role, no session, the invitation accepted and the token used once', async () => {
    // GIVEN a pending invitation to `bob@example.com`, who has no account.
    const invitation = await pendingInvitation('member');
    const before = await pools.authPool.query(`select 1 from auth."user" where email = $1`, [
      invitation.email,
    ]);
    expect(before.rows, 'bob has no account').toHaveLength(0);

    // WHEN `bob` presents the invitation id, the token and a policy-compliant password (no cookie).
    const response = await accept({
      invitationId: invitation.invitationId,
      token: invitation.token,
      password: ACCEPT_PASSWORD,
    });
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(200);
    expect(response.statusCode, response.body).toBeLessThan(300);
    expect(response.body).not.toContain(invitation.token);
    expect(response.body).not.toContain(ACCEPT_PASSWORD);

    // THEN `bob` has an account with a verified email...
    const users = await pools.authPool.query<{ id: string; email_verified: boolean }>(
      `select id, email_verified from auth."user" where email = $1`,
      [invitation.email],
    );
    expect(users.rows).toHaveLength(1);
    const userId = users.rows[0]?.id ?? '';
    expect(users.rows[0]?.email_verified).toBe(true);

    // ...a membership with the invited role...
    const members = await pools.authPool.query<{ role: string }>(
      `select role from auth.member where organization_id = $1 and user_id = $2`,
      [invitation.tenantId, userId],
    );
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0]?.role).toBe('member');

    // ...and status `Active`...
    const row = await userSync.getUser({
      tenantId: invitation.tenantId,
      email: invitation.email,
    });
    expect(row?.status).toBe('Active');

    // ...and no session exists: no cookie in the response and no session row.
    expect(response.headers['set-cookie']).toBeUndefined();
    const sessions = await pools.authPool.query(`select 1 from auth.session where user_id = $1`, [
      userId,
    ]);
    expect(sessions.rows, 'no session').toHaveLength(0);

    // AND the invitation is `accepted`...
    const invitationRow = await pools.authPool.query<{ status: string }>(
      `select status from auth.invitation where id = $1`,
      [invitation.invitationId],
    );
    expect(invitationRow.rows[0]?.status).toBe('accepted');

    // ...and the token cannot be used a second time (the uniform 404 of a rejected acceptance).
    const second = await accept({
      invitationId: invitation.invitationId,
      token: invitation.token,
      password: ACCEPT_PASSWORD,
    });
    expect(second.statusCode).toBe(404);
    const unknown = await accept({
      invitationId: `unknown-${randomUUID()}`,
      token: invitation.token,
      password: ACCEPT_PASSWORD,
    });
    expect(unknown.statusCode).toBe(404);
    expect(second.body, 'same body as an unknown invitation').toBe(unknown.body);

    // ...and bob can then sign in with the password he set.
    const signedIn = await signIn(invitation.email, ACCEPT_PASSWORD);
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect(signedIn.headers['set-cookie']).toBeDefined();
  }, 120_000);

  it('The accept route is absent from the OpenAPI document and from the contract:check input', async () => {
    // Registered as a Fastify route (a body-less call is answered by the route, not the catch-all's 401).
    const probe = await accept({});
    expect(probe.statusCode).not.toBe(401);

    // The generated document (the contract:check input) does not list it.
    const generated = JSON.stringify(await generateIdentityOpenApiDocument());
    expect(generated).not.toContain('invitations/accept');
    expect(generated).not.toContain('/v1/auth/');

    // Neither does the committed file nor any committed OpenAPI document.
    const dir = join(repoRoot, 'openapi');
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
      const text = readFileSync(join(dir, name), 'utf8');
      expect(text, name).not.toContain('invitations/accept');
    }

    // contract:check passes without the route.
    const result = await checkIdentityContract();
    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);
  }, 120_000);
});
