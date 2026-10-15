/**
 * Task 14.7 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (spec
 * "Invitation acceptance"; design D4 step 4 "Existing account"; Resolved
 * decisions Q24, Q38 and Q47).
 *
 * Task 14.7 Verify: "`accept-existing.http.int.test.ts` covers a request without the
 * CSRF header, one from a foreign origin and one with no `Origin` header each being
 * refused with the uniform rejection, a request with no session for an existing
 * account answering the same 404 as a wrong token, a matching session plus the token
 * succeeding with the same status and body shape as the new-account path (for an
 * account whose email was never verified), and an `admin` invitation answering
 * `AUTH_STEP_UP_REQUIRED` only after the token and the session matched."
 *
 * Scenarios (from the spec):
 * - "A cross-site request cannot accept": WHEN an existing-account acceptance arrives
 *   without the CSRF custom header, with no `Origin` header, or from a disallowed
 *   origin THEN the answer is the uniform rejection and nothing changes.
 * - "Acceptance does not touch an existing account": without a session, the uniform
 *   rejection.
 * - "An existing account accepts with its session": the membership with the invited
 *   role, the `_user` `Active`, the email now verified, the session unchanged, the
 *   same status and shape as a new person's acceptance.
 * - "An admin invitation to an existing account needs step-up": without a fresh
 *   step-up, `AUTH_STEP_UP_REQUIRED` and nothing changes; a wrong token gets the
 *   uniform rejection, not `AUTH_STEP_UP_REQUIRED`.
 *
 * ## Harness
 *
 * The real server (`createApp`, injected requests, never a listener), as in
 * `accept-route.http.int.test.ts`. The invitation is created in process through the
 * identity router; the token is read from the recording sender. The existing
 * account is created by `createAdminUser` (email never verified) and signed in
 * through Better Auth, giving the session cookie. Every HTTP request carries a fresh
 * random `x-forwarded-for`.
 *
 * ## Production symbols expected
 *
 * - `POST /v1/auth/invitations/accept` (registered by `createApp` in `./server.js`,
 *   with `mountIdentityRoutes`) reads the session cookie, requires the CSRF custom
 *   header (`x-csrf-token: orpc`) and an `Origin` header present and in
 *   `allowedOrigins`, and answers the uniform 404 for any failure of those, for a
 *   missing or mismatched session and for a wrong token; for an `admin` invitation
 *   it answers 403 `AUTH_STEP_UP_REQUIRED` only after those passed. On success it
 *   answers 200 `{ userId }` like the new-account path.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { createRecordingEmailSender } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
  testAppPool,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { sessionTokenOfCookie } from './__fixtures__/fresh-mfa.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createEmailTenantGate } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createIdentityRouter } from './identity-router.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const FOREIGN_ORIGIN = 'https://evil.example';
const LINK_BASE_URL = 'https://app.tayzu.test';
const ACCEPT_PATH = '/v1/auth/invitations/accept';
const NEW_PERSON_PASSWORD = 'Café-Mañana-Passäphrase-2026!';

interface Pending {
  readonly tenantId: string;
  readonly email: string;
  readonly invitationId: string;
  readonly token: string;
}

interface Existing {
  readonly userId: string;
  readonly email: string;
  readonly cookie: string;
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('Existing-account acceptance over HTTP (task 14.7, design D4 step 4, Q24, Q38)', () => {
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
      ...{
        mountIdentityRoutes: true,
        identityTokenHmacSecret: 'mount-wiring-test-only-secret-0123456789-abcdef',
      },
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
          recipientKeySecret: 'gate-wiring-test-only-secret-0123456789-abcdef',
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

  async function newTenant(): Promise<BootstrappedTenant> {
    const id = randomUUID();
    return await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Accept Existing Admin',
      email: `accept-existing-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Accept Existing Org',
      organizationSlug: `accept-existing-${id}`,
      ip: randomIp(),
    });
  }

  /** A pending invitation to `email` in a fresh tenant, with the token from its email. */
  async function invite(email: string, role: 'member' | 'admin'): Promise<Pending> {
    const admin = await newTenant();
    const headers = new Headers({ cookie: admin.cookie, 'x-forwarded-for': randomIp() });
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

  /** An account whose email was never verified, signed in: its session cookie. */
  async function existingAccount(): Promise<Existing> {
    const email = `carol-${randomUUID()}@example.test`;
    const created = await createAdminUser(app.auth, {
      name: 'Carol Existing',
      email,
      password: TEST_PASSWORD,
    });
    const signedIn = await signInAdminUser(app.auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    return { userId: created.userId, email, cookie: signedIn.cookie };
  }

  /** Drops the step-up marker of a session, so no fresh step-up exists. */
  async function dropMarker(cookie: string): Promise<void> {
    await pools.authPool.query('delete from auth.verification where identifier = $1', [
      `step-up-verified:${sessionTokenOfCookie(cookie)}`,
    ]);
  }

  /** The acceptance request; `omit` removes a header from the otherwise valid set. */
  function accept(
    body: Record<string, unknown>,
    options: {
      cookie?: string;
      omit?: 'x-csrf-token' | 'origin';
      origin?: string;
    } = {},
  ) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      origin: options.origin ?? ORIGIN,
      'x-csrf-token': 'orpc',
      'x-forwarded-for': randomIp(),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    };
    if (options.omit !== undefined) Reflect.deleteProperty(headers, options.omit);
    return app.app.inject({
      method: 'POST',
      url: ACCEPT_PATH,
      headers,
      payload: JSON.stringify(body),
    });
  }

  async function memberRows(tenantId: string, userId: string): Promise<number> {
    const result = await pools.authPool.query(
      `select 1 from auth.member where organization_id = $1 and user_id = $2`,
      [tenantId, userId],
    );
    return result.rows.length;
  }

  async function invitationStatus(invitationId: string): Promise<string | undefined> {
    const result = await pools.authPool.query<{ status: string }>(
      `select status from auth.invitation where id = $1`,
      [invitationId],
    );
    return result.rows[0]?.status;
  }

  async function emailVerified(userId: string): Promise<boolean | undefined> {
    const result = await pools.authPool.query<{ email_verified: boolean }>(
      `select email_verified from auth."user" where id = $1`,
      [userId],
    );
    return result.rows[0]?.email_verified;
  }

  /** The uniform rejection of an acceptance that failed for any reason: an unknown invitation. */
  async function uniformRejection(cookie: string) {
    const response = await accept(
      { invitationId: `unknown-${randomUUID()}`, token: 'a'.repeat(32) },
      { cookie },
    );
    expect(response.statusCode).toBe(404);
    return response;
  }

  async function expectRefusedAndUnchanged(
    pending: Pending,
    existing: Existing,
    response: Awaited<ReturnType<typeof accept>>,
  ): Promise<void> {
    const reference = await uniformRejection(existing.cookie);
    expect(response.statusCode, response.body).toBe(404);
    expect(response.body, 'the uniform rejection body').toBe(reference.body);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await memberRows(pending.tenantId, existing.userId), 'no membership').toBe(0);
    expect(await invitationStatus(pending.invitationId), 'the invitation stays pending').toBe(
      'pending',
    );
    expect(await emailVerified(existing.userId), 'the email stays unverified').toBe(false);
  }

  it('A cross-site request cannot accept: a request without the CSRF custom header is refused with the uniform rejection', async () => {
    const existing = await existingAccount();
    const pending = await invite(existing.email, 'member');
    const response = await accept(
      { invitationId: pending.invitationId, token: pending.token },
      { cookie: existing.cookie, omit: 'x-csrf-token' },
    );
    await expectRefusedAndUnchanged(pending, existing, response);
  }, 120_000);

  it('A cross-site request cannot accept: a request from a foreign origin is refused with the uniform rejection', async () => {
    const existing = await existingAccount();
    const pending = await invite(existing.email, 'member');
    const response = await accept(
      { invitationId: pending.invitationId, token: pending.token },
      { cookie: existing.cookie, origin: FOREIGN_ORIGIN },
    );
    await expectRefusedAndUnchanged(pending, existing, response);
  }, 120_000);

  it('A cross-site request cannot accept: a request with no Origin header is refused with the uniform rejection', async () => {
    const existing = await existingAccount();
    const pending = await invite(existing.email, 'member');
    const response = await accept(
      { invitationId: pending.invitationId, token: pending.token },
      { cookie: existing.cookie, omit: 'origin' },
    );
    await expectRefusedAndUnchanged(pending, existing, response);
  }, 120_000);

  it('Acceptance does not touch an existing account: a request with no session answers the same 404 as a wrong token', async () => {
    const existing = await existingAccount();
    const pending = await invite(existing.email, 'member');

    const noSession = await accept({ invitationId: pending.invitationId, token: pending.token });
    const wrongToken = await accept(
      { invitationId: pending.invitationId, token: 'b'.repeat(pending.token.length) },
      { cookie: existing.cookie },
    );
    expect(noSession.statusCode, noSession.body).toBe(404);
    expect(wrongToken.statusCode, wrongToken.body).toBe(404);
    expect(noSession.body, 'the same body as a wrong token').toBe(wrongToken.body);
    expect(await memberRows(pending.tenantId, existing.userId)).toBe(0);
    expect(await invitationStatus(pending.invitationId)).toBe('pending');
    expect(await emailVerified(existing.userId)).toBe(false);
  }, 120_000);

  it('An existing account accepts with its session: the same status and body shape as the new-account path, for an account whose email was never verified', async () => {
    // GIVEN a pending invitation to `carol`, who has an account (email never verified) and a session.
    const existing = await existingAccount();
    expect(await emailVerified(existing.userId), 'never verified').toBe(false);
    const pending = await invite(existing.email, 'member');

    // WHEN she presents the token with her session, the CSRF header and an allowed origin.
    const response = await accept(
      { invitationId: pending.invitationId, token: pending.token },
      { cookie: existing.cookie },
    );
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(200);
    expect(response.statusCode, response.body).toBeLessThan(300);
    expect(response.body).not.toContain(pending.token);

    // THEN she gains the membership with the invited role and her `_user` becomes `Active`.
    const members = await pools.authPool.query<{ role: string }>(
      `select role from auth.member where organization_id = $1 and user_id = $2`,
      [pending.tenantId, existing.userId],
    );
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0]?.role).toBe('member');
    const row = await userSync.getUser({ tenantId: pending.tenantId, email: existing.email });
    expect(row?.status).toBe('Active');

    // AND her email is now marked verified, and the invitation is accepted.
    expect(await emailVerified(existing.userId)).toBe(true);
    expect(await invitationStatus(pending.invitationId)).toBe('accepted');

    // AND her password and session are unchanged: no new cookie, and the session still works.
    expect(response.headers['set-cookie']).toBeUndefined();
    const sessions = await pools.authPool.query(`select 1 from auth.session where token = $1`, [
      sessionTokenOfCookie(existing.cookie),
    ]);
    expect(sessions.rows, 'her session still exists').toHaveLength(1);
    const signedIn = await signInAdminUser(app.auth, {
      email: existing.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    expect(signedIn.userId).toBe(existing.userId);

    // AND the response has the same status and shape as a new person's acceptance.
    const newcomer = await invite(`bob-${randomUUID()}@example.test`, 'member');
    const created = await accept({
      invitationId: newcomer.invitationId,
      token: newcomer.token,
      password: NEW_PERSON_PASSWORD,
    });
    expect(created.statusCode, created.body).toBe(response.statusCode);
    const shapeOf = (body: string): string[] =>
      Object.keys(JSON.parse(body) as Record<string, unknown>).sort();
    expect(shapeOf(response.body)).toEqual(shapeOf(created.body));

    // AND the token cannot be used a second time.
    const replay = await accept(
      { invitationId: pending.invitationId, token: pending.token },
      { cookie: existing.cookie },
    );
    expect(replay.statusCode).toBe(404);
  }, 120_000);

  it('An admin invitation to an existing account needs step-up: AUTH_STEP_UP_REQUIRED only after the token and the session matched', async () => {
    // GIVEN a pending `admin` invitation to `carol` and her matching session without a step-up marker.
    const existing = await existingAccount();
    await dropMarker(existing.cookie);
    const pending = await invite(existing.email, 'admin');
    const unchanged = async (): Promise<void> => {
      expect(await memberRows(pending.tenantId, existing.userId), 'no membership').toBe(0);
      expect(await invitationStatus(pending.invitationId)).toBe('pending');
      expect(await emailVerified(existing.userId)).toBe(false);
    };

    // A wrong token gets the uniform rejection, not AUTH_STEP_UP_REQUIRED.
    const wrongToken = await accept(
      { invitationId: pending.invitationId, token: 'c'.repeat(pending.token.length) },
      { cookie: existing.cookie },
    );
    expect(wrongToken.statusCode, wrongToken.body).toBe(404);
    expect(wrongToken.body).not.toContain('AUTH_STEP_UP_REQUIRED');

    // So does a request whose session does not match (no session).
    const noSession = await accept({ invitationId: pending.invitationId, token: pending.token });
    expect(noSession.statusCode, noSession.body).toBe(404);
    expect(noSession.body).not.toContain('AUTH_STEP_UP_REQUIRED');

    // So does a request without the CSRF header.
    const noCsrf = await accept(
      { invitationId: pending.invitationId, token: pending.token },
      { cookie: existing.cookie, omit: 'x-csrf-token' },
    );
    expect(noCsrf.statusCode, noCsrf.body).toBe(404);
    expect(noCsrf.body).not.toContain('AUTH_STEP_UP_REQUIRED');

    // WHEN she presents the valid token without a fresh step-up verification.
    const response = await accept(
      { invitationId: pending.invitationId, token: pending.token },
      { cookie: existing.cookie },
    );

    // THEN it fails with AUTH_STEP_UP_REQUIRED and nothing changes.
    expect(response.statusCode, response.body).toBe(403);
    expect((JSON.parse(response.body) as { code?: unknown }).code).toBe('AUTH_STEP_UP_REQUIRED');
    await unchanged();
  }, 120_000);
});
