/**
 * Task 6.1 of openspec/changes/archive/2026-11-16-044-password-reset-and-account-recovery (design D2 "The routes"
 * and "Order of work, request route", D4 "Uniform answer", Resolved decision Q24).
 *
 * Task 6.1 Verify (the part of this file): scenarios "An unknown address and an eligible account
 * get the same answer" and "A malformed request fails before any lookup" of
 * `specs/password-reset-and-account-recovery/spec.md`.
 *
 * Scenarios (verbatim from the spec):
 * - "An unknown address and an eligible account get the same answer": GIVEN `known@example.com`
 *   with a password and no second factor, and `ghost@example.com` with no account; WHEN each
 *   address is posted to the request route; THEN both answers have status `200` and the body
 *   `{ "accepted": true }`, with the same header names; AND exactly one `PasswordResetEmail` is
 *   sent, to `known@example.com`.
 * - "A malformed request fails before any lookup": WHEN the request route receives a body with an
 *   unknown field, a non-string email, an email longer than 254 characters or a `__proto__` key;
 *   THEN it answers `CATALOG_VALIDATION_FAILED` and performs no account lookup.
 *
 * ## Harness
 *
 * The real server (`createApp`, injected requests, never a listener) with the identity routes
 * mounted, over a recording email sender. The known account is a bootstrapped tenant admin (a
 * password account, a membership and an Active `_user` row). Every request carries a fresh random
 * `x-forwarded-for`, `Origin` and `x-csrf-token: orpc`, so neither the limiter nor the CSRF check
 * interferes. "No account lookup" is observed on the `tayzu_auth` pool handed to `createApp`: a
 * wrapper records the text of every statement, and a lookup is a statement that touches the
 * Better Auth `user`, `account`, `member` or `verification` tables. The same wrapper is the
 * control: a valid request must produce such statements, so the assertion is not vacuous.
 *
 * ## Production symbols expected
 *
 * - `createApp` (`./server.js`) registers `POST /v1/auth/password-reset/request` as a plain
 *   Fastify route in the `mountIdentityRoutes` block, before the `/v1/*` catch-all.
 * - `CreateAppOptions.email.passwordResetLinkBaseUrl?: string` (`PASSWORD_RESET_LINK_BASE_URL`):
 *   the origin of the emailed link, next to `invitationLinkBaseUrl`. (Passed through a variable,
 *   so this file type-checks before the option exists.)
 * - The route answers `200 { "accepted": true }` for a well-formed, same-site request whatever
 *   the account, and `400 CATALOG_VALIDATION_FAILED` for a malformed body, before any lookup.
 * - For an eligible account, one `PasswordResetEmail` reaches `email.sender` (detached from the
 *   response), addressed to the canonical address.
 */
// Load-bearing import order (design D1): the telemetry harness registers before anything that
// loads `@tayzu/auth` creates its logger (task 6.3 reads the `token_issue_failure` log event).
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { createRecordingEmailSender } from '@tayzu/auth';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  seedUserRow,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createResetTokenStore } from './identity/reset-token-store.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const LINK_BASE_URL = 'https://app.tayzu.test';
const REQUEST_PATH = '/v1/auth/password-reset/request';
const HMAC_SECRET = 'reset-request-test-only-secret-0123456789-abcdef';
const ACCOUNT_TABLES = /"user"|auth\.user\b|auth\.account\b|auth\.member\b|auth\.verification\b/i;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

type QueryFunction = (...args: unknown[]) => unknown;

function statementText(first: unknown): string {
  if (typeof first === 'string') return first;
  if (typeof first === 'object' && first !== null && 'text' in first) {
    return typeof first.text === 'string' ? first.text : '';
  }
  return '';
}

/** Wraps a pool (and the clients it hands out) so that every statement's text is recorded. */
function spyOnPool(pool: Pool, record: (sql: string) => void): Pool {
  const spyOnClient = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'query') {
          return (...args: unknown[]): unknown => {
            record(statementText(args[0]));
            return (value as QueryFunction).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as QueryFunction).bind(target) : value;
      },
    });
  return new Proxy(pool, {
    get(target, property): unknown {
      const value: unknown = Reflect.get(target, property, target);
      if (property === 'query') {
        return (...args: unknown[]): unknown => {
          record(statementText(args[0]));
          return (value as QueryFunction).apply(target, args);
        };
      }
      if (property === 'connect') {
        return async (): Promise<PoolClient> => spyOnClient(await target.connect());
      }
      return typeof value === 'function' ? (value as QueryFunction).bind(target) : value;
    },
  });
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly headerNames: readonly string[];
}

describe('POST /v1/auth/password-reset/request over HTTP (task 6.1, design D2, D4, Q24)', () => {
  let app: App;
  let sender: ReturnType<typeof createRecordingEmailSender>;
  let statements: string[];
  let knownEmail: string;

  beforeAll(async () => {
    const pools = await harnessPools();
    statements = [];
    sender = createRecordingEmailSender();
    const email = {
      sender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
      passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
    };
    app = await createApp({
      appPool: pools.appPool,
      authPool: spyOnPool(pools.authPool, (sql) => statements.push(sql)),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });

    const suffix = randomUUID();
    knownEmail = `known-${suffix}@example.test`;
    await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Known User',
      email: knownEmail,
      password: TEST_PASSWORD,
      organizationName: `Reset Request Org ${suffix}`,
      organizationSlug: `reset-request-${suffix}`,
      ip: randomIp(),
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  async function post(payload: string | Record<string, unknown>): Promise<Answer> {
    const response = await app.app.inject({
      method: 'POST',
      url: REQUEST_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return {
      status: response.statusCode,
      body,
      headerNames: Object.keys(response.headers).sort(),
    };
  }

  function resetEmailsTo(address: string) {
    return sender.sent.filter(
      (message) => message.to === address && message.template.kind === 'PasswordResetEmail',
    );
  }

  it('An unknown address and an eligible account get the same answer: 200 { accepted: true }, the same header names, and exactly one PasswordResetEmail, to the known address', async () => {
    const ghostEmail = `ghost-${randomUUID()}@example.test`;

    const ghost = await post({ email: ghostEmail });
    const known = await post({ email: knownEmail });

    expect(ghost.status).toBe(200);
    expect(ghost.body).toEqual({ accepted: true });
    expect(known.status).toBe(200);
    expect(known.body).toEqual({ accepted: true });
    expect(known.headerNames).toEqual(ghost.headerNames);

    // The send is detached from the response: wait for it.
    await vi.waitFor(() => {
      expect(resetEmailsTo(knownEmail)).toHaveLength(1);
    });
    expect(sender.sent.filter((message) => message.to === ghostEmail)).toHaveLength(0);
  });

  describe('A malformed request fails before any lookup', () => {
    const cases: readonly { readonly name: string; readonly payload: () => string }[] = [
      {
        name: 'an unknown field',
        payload: () => JSON.stringify({ email: 'someone@example.test', extra: 1 }),
      },
      { name: 'a non-string email', payload: () => JSON.stringify({ email: 12_345 }) },
      {
        name: 'an email longer than 254 characters',
        payload: () => JSON.stringify({ email: `${'a'.repeat(250)}@example.test` }),
      },
      {
        name: 'a __proto__ key',
        payload: () => '{"email":"someone@example.test","__proto__":{"polluted":true}}',
      },
    ];

    for (const { name, payload } of cases) {
      it(`${name}: CATALOG_VALIDATION_FAILED, no account lookup, no email`, async () => {
        const sentBefore = sender.sent.length;
        const before = statements.length;

        const answer = await post(payload());

        expect(answer.status).toBe(400);
        expect(answer.body).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
        const lookups = statements.slice(before).filter((sql) => ACCOUNT_TABLES.test(sql));
        expect(lookups, 'no statement touched the account tables').toEqual([]);
        expect(sender.sent).toHaveLength(sentBefore);
      });
    }

    it('control: a well-formed request does look the account up, so the observation above is not vacuous', async () => {
      const before = statements.length;

      const answer = await post({ email: `control-${randomUUID()}@example.test` });

      expect(answer.status).toBe(200);
      const lookups = statements.slice(before).filter((sql) => ACCOUNT_TABLES.test(sql));
      expect(lookups.length).toBeGreaterThan(0);
    });
  });
});

/**
 * Task 6.2 (design D4 "Uniform answer"): scenario "Every refusal state gets the same answer" of
 * `specs/password-reset-and-account-recovery/spec.md`.
 *
 * GIVEN an SSO-only account, a banned account, an account `Disabled` in its only tenant, an
 * address on a full recipient cap, a kill switch turned on, and a provider that fails; WHEN each
 * is posted to the request route in turn; THEN every answer equals the answer for an eligible
 * account and for an unknown address, and no response names the state.
 *
 * Three apps over one database: A (recording sender, recipient cap of 1), B (kill switch on) and
 * C (a sender that always fails with the recipient address in its error). Every state uses its
 * own freshly created account, so nothing is shared between cases.
 */
describe('Every refusal state gets the same answer (task 6.2)', () => {
  let appA: App;
  let appB: App;
  let appC: App;
  let senderA: ReturnType<typeof createRecordingEmailSender>;
  let senderB: ReturnType<typeof createRecordingEmailSender>;
  let failedSends: number;
  let sentToFailing: string[];
  let authPool: Pool;

  function emailOptions(
    sender: { send: (to: string, template: never) => Promise<void> },
    overrides: { killSwitch: boolean; recipientMax: number },
  ) {
    return {
      sender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      disabledTenantIds: [] as string[],
      killSwitch: overrides.killSwitch,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
      passwordResetRecipientCap: { max: overrides.recipientMax, windowSeconds: 3600 },
      passwordResetIpCap: { max: 1000, windowSeconds: 3600 },
      passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
    };
  }

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    senderA = createRecordingEmailSender();
    senderB = createRecordingEmailSender();
    failedSends = 0;
    sentToFailing = [];
    const failing = {
      send: (to: string): Promise<void> => {
        failedSends += 1;
        sentToFailing.push(to);
        return Promise.reject(new Error(`provider rejected ${to}`));
      },
    };
    const base = {
      appPool: pools.appPool,
      authPool: pools.authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
    };
    appA = await createApp({
      ...base,
      email: emailOptions(senderA, { killSwitch: false, recipientMax: 1 }),
    });
    appB = await createApp({
      ...base,
      email: emailOptions(senderB, { killSwitch: true, recipientMax: 1000 }),
    });
    appC = await createApp({
      ...base,
      email: emailOptions(failing, { killSwitch: false, recipientMax: 1000 }),
    });
  }, 120_000);

  afterAll(async () => {
    await appA.close();
    await appB.close();
    await appC.close();
  }, 60_000);

  async function post(app: App, email: string): Promise<Answer> {
    const response = await app.app.inject({
      method: 'POST',
      url: REQUEST_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify({ email }),
    });
    return {
      status: response.statusCode,
      body: response.json(),
      headerNames: Object.keys(response.headers).sort(),
    };
  }

  /** A fresh password account that is the admin of its own tenant; optionally Disabled there. */
  async function createAccount(
    status: 'Active' | 'Disabled' = 'Active',
  ): Promise<{ email: string; userId: string; tenantId: string }> {
    const suffix = randomUUID();
    const email = `refusal-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(appA.auth, {
      pool: testAppPool(),
      name: 'Refusal User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Refusal Org ${suffix}`,
      organizationSlug: `refusal-${suffix}`,
      ip: randomIp(),
      writeUserRow: false,
    });
    await seedUserRow(testAppPool(), {
      tenantId: tenant.organizationId,
      email,
      name: 'Refusal User',
      status,
      portRole: 'admin',
    });
    if (status === 'Disabled') {
      // The membership hook may have written the Active row first (seedUserRow leaves it as is).
      const client = await testAppPool().connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenant.organizationId]);
        await client.query(
          `update catalog_entity
              set spec_properties = jsonb_set(spec_properties, '{status}', '"Disabled"')
            where tenant_id = $1 and identifier = $2`,
          [tenant.organizationId, email],
        );
        await client.query('commit');
      } finally {
        client.release();
      }
    }
    return { email, userId: tenant.userId, tenantId: tenant.organizationId };
  }

  function sentTo(address: string): number {
    return senderA.sent.filter((message) => message.to === address).length;
  }

  function expectSameAnswer(actual: Answer, expected: Answer): void {
    expect(actual.status).toBe(expected.status);
    expect(actual.body).toEqual(expected.body);
    expect(actual.headerNames).toEqual(expected.headerNames);
  }

  it('SSO-only, banned, disabled everywhere, full cap, kill switch and failing provider each answer exactly like an eligible account and an unknown address', async () => {
    // The two reference answers.
    const eligible = await createAccount();
    const eligibleAnswer = await post(appA, eligible.email);
    const unknownAnswer = await post(appA, `ghost-${randomUUID()}@example.test`);
    expect(eligibleAnswer.status).toBe(200);
    expect(eligibleAnswer.body).toEqual({ accepted: true });
    expectSameAnswer(unknownAnswer, eligibleAnswer);
    await vi.waitFor(() => {
      expect(sentTo(eligible.email)).toBe(1);
    });

    // SSO-only: the credential account is replaced by a linked sign-in.
    const sso = await createAccount();
    await authPool.query(
      `delete from auth.account where user_id = $1 and provider_id = 'credential'`,
      [sso.userId],
    );
    await authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, 'visma-connect', $3, now(), now())`,
      [`acc-${randomUUID()}`, `sso-${randomUUID()}`, sso.userId],
    );
    const ssoAnswer = await post(appA, sso.email);

    // Banned.
    const banned = await createAccount();
    await authPool.query('update auth."user" set banned = true where id = $1', [banned.userId]);
    const bannedAnswer = await post(appA, banned.email);

    // Disabled in its only tenant.
    const disabled = await createAccount('Disabled');
    const disabledAnswer = await post(appA, disabled.email);

    // A full recipient cap (app A allows one reset email per address per hour).
    const capped = await createAccount();
    const firstOfCapped = await post(appA, capped.email);
    await vi.waitFor(() => {
      expect(sentTo(capped.email)).toBe(1);
    });
    const cappedAnswer = await post(appA, capped.email);

    // The kill switch (app B).
    const killed = await createAccount();
    const killedAnswer = await post(appB, killed.email);

    // A provider that fails (app C), with the address inside its error.
    const failing = await createAccount();
    const failingAnswer = await post(appC, failing.email);
    await vi.waitFor(() => {
      expect(failedSends).toBeGreaterThanOrEqual(1);
    });

    expectSameAnswer(firstOfCapped, eligibleAnswer);
    for (const answer of [
      ssoAnswer,
      bannedAnswer,
      disabledAnswer,
      cappedAnswer,
      killedAnswer,
      failingAnswer,
    ]) {
      expectSameAnswer(answer, eligibleAnswer);
      expectSameAnswer(answer, unknownAnswer);
      expect(JSON.stringify(answer.body)).toBe('{"accepted":true}');
    }

    // Give a wrongly attempted detached send time to land, then check each refusal sent nothing.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sentTo(sso.email)).toBe(0);
    expect(sentTo(banned.email)).toBe(0);
    expect(sentTo(disabled.email)).toBe(0);
    expect(sentTo(capped.email)).toBe(1);
    expect(senderB.sent).toHaveLength(0);
    expect(sentToFailing).toEqual([failing.email]);
  }, 120_000);
});

/**
 * Task 6.3 (design D5 "Admission before issue", D3 "Newest wins, for an admitted send only", D4
 * "Detached send", review correction C1): scenarios "A suppressed request leaves the earlier link
 * valid" (one case each for a full recipient cap, the kill switch, every tenant disabled and a
 * recipient domain off the allowlist) and "The newest link wins", plus the case "a token-store
 * failure after admission still answers the uniform 200 and logs `token_issue_failure`".
 *
 * Scenarios (verbatim from the spec):
 * - "The newest link wins": GIVEN an eligible user who requested a reset twice; WHEN the first
 *   link is submitted; THEN the answer is the uniform rejection, and the second link still works.
 * - "A suppressed request leaves the earlier link valid": GIVEN an eligible user who holds a valid
 *   link, and then a full recipient cap, a kill switch turned on, every tenant of the user on the
 *   disabled-tenant list, or a recipient domain that is not on the allowlist; WHEN the address is
 *   posted again; THEN the answer is the uniform one, no email is sent, no token is issued, and
 *   the earlier link still works.
 *
 * The confirm route does not exist before task 8.3, so "the link is submitted" and "still works"
 * are observed at the token store (`lookup(id, token)` with the id and token read from the emailed
 * link): `found` is a working link, `not_found` is the uniform rejection. "No token is issued" is
 * observed as the user's `password-reset:` rows being exactly the earlier row, unchanged.
 *
 * ## Production symbols expected
 *
 * - `CreateAppOptions.email.recipientDomainAllowlist?: readonly string[]` (`server.ts`), handed to
 *   `createRecoveryMailer({ recipientDomainAllowlist })`, which already supports it, so that the
 *   mailer's admission (not only the sender wrapper) refuses a domain off the list. Passed here
 *   through a variable, so this file type-checks before the option exists.
 * - The request route catches a token-store failure after admission, logs
 *   `catalog.security.recovery_email_suppressed` with `tayzu.identity.recovery.suppression` =
 *   `token_issue_failure`, sends nothing and answers the uniform `200 { "accepted": true }`.
 */
describe('Admission before issue (task 6.3)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let apps: App[];
  let failTokenInsert: boolean;

  const roomy = { max: 1000, windowSeconds: 3600 };

  function makeApp(
    sender: ReturnType<typeof createRecordingEmailSender>,
    overrides: Record<string, unknown> = {},
    pool: Pool = authPool,
  ): Promise<App> {
    const email = {
      sender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: roomy,
      recipientCap: { max: 1000, windowSeconds: 86_400 },
      passwordResetRecipientCap: roomy,
      passwordResetIpCap: roomy,
      passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
      ...overrides,
    };
    return harnessPools().then(async (pools) => {
      const app = await createApp({
        appPool: pools.appPool,
        authPool: pool,
        authSecret: TEST_SECRET,
        cerbosAddress: 'localhost:3593',
        allowedOrigins: [ORIGIN],
        mountIdentityRoutes: true,
        identityTokenHmacSecret: HMAC_SECRET,
        ...{ email },
      });
      apps.push(app);
      return app;
    });
  }

  /** Fails the reset token's insert while `failTokenInsert` is on; everything else passes. */
  function failingInsertPool(pool: Pool): Pool {
    const guard = (first: unknown, run: () => unknown): unknown =>
      failTokenInsert && /insert\s+into\s+auth\.verification/i.test(statementText(first))
        ? Promise.reject(new Error('token store unavailable'))
        : run();
    const wrapClient = (client: PoolClient): PoolClient =>
      new Proxy(client, {
        get(target, property): unknown {
          const value: unknown = Reflect.get(target, property, target);
          if (property === 'query') {
            return (...args: unknown[]): unknown =>
              guard(args[0], () => (value as QueryFunction).apply(target, args));
          }
          return typeof value === 'function' ? (value as QueryFunction).bind(target) : value;
        },
      });
    return new Proxy(pool, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'query') {
          return (...args: unknown[]): unknown =>
            guard(args[0], () => (value as QueryFunction).apply(target, args));
        }
        if (property === 'connect') {
          return async (): Promise<PoolClient> => wrapClient(await target.connect());
        }
        return typeof value === 'function' ? (value as QueryFunction).bind(target) : value;
      },
    });
  }

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    authPool = (await harnessPools()).authPool;
    apps = [];
  }, 60_000);

  beforeEach(async () => {
    failTokenInsert = false;
    await harness.reset();
  });

  afterAll(async () => {
    for (const app of apps) await app.close();
  }, 60_000);

  async function post(app: App, email: string): Promise<Answer> {
    const response = await app.app.inject({
      method: 'POST',
      url: REQUEST_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify({ email }),
    });
    return {
      status: response.statusCode,
      body: response.json(),
      headerNames: Object.keys(response.headers).sort(),
    };
  }

  async function createAccount(app: App): Promise<{
    email: string;
    userId: string;
    tenantId: string;
  }> {
    const suffix = randomUUID();
    const email = `admission-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Admission User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Admission Org ${suffix}`,
      organizationSlug: `admission-${suffix}`,
      ip: randomIp(),
    });
    return { email, userId: tenant.userId, tenantId: tenant.organizationId };
  }

  async function tokenRows(userId: string): Promise<{ identifier: string; value: string }[]> {
    const result = await authPool.query<{ identifier: string; value: string }>(
      `select identifier, value from auth.verification
        where identifier like 'password-reset:%' and split_part(value, ':', 3) = $1
        order by identifier`,
      [userId],
    );
    return result.rows;
  }

  function linksTo(
    sender: ReturnType<typeof createRecordingEmailSender>,
    address: string,
  ): { id: string; token: string }[] {
    const links: { id: string; token: string }[] = [];
    for (const message of sender.sent) {
      if (message.to !== address || message.template.kind !== 'PasswordResetEmail') continue;
      const fragment = new URLSearchParams(new URL(message.template.link).hash.slice(1));
      links.push({ id: fragment.get('reset') ?? '', token: fragment.get('token') ?? '' });
    }
    return links;
  }

  function store() {
    return createResetTokenStore({ authPool, withUserLock: createWithUserLock(authPool) });
  }

  /** The user's first, admitted request: one email, one row, and the link works. */
  async function holdAValidLink(
    app: App,
    sender: ReturnType<typeof createRecordingEmailSender>,
    account: { email: string; userId: string },
  ) {
    const answer = await post(app, account.email);
    expect(answer.status).toBe(200);
    await vi.waitFor(() => {
      expect(linksTo(sender, account.email)).toHaveLength(1);
    });
    const [link] = linksTo(sender, account.email);
    const rows = await tokenRows(account.userId);
    expect(rows).toHaveLength(1);
    expect(link).toBeDefined();
    const earlier = link as { id: string; token: string };
    expect(await store().lookup(earlier.id, earlier.token)).toMatchObject({ status: 'found' });
    return { answer, earlier, rows };
  }

  async function expectSuppressedAndEarlierLinkValid(input: {
    sender: ReturnType<typeof createRecordingEmailSender>;
    account: { email: string; userId: string };
    reference: Awaited<ReturnType<typeof holdAValidLink>>;
    answer: Answer;
  }): Promise<void> {
    const { sender, account, reference, answer } = input;
    expect(answer.status).toBe(reference.answer.status);
    expect(answer.body).toEqual({ accepted: true });
    expect(answer.headerNames).toEqual(reference.answer.headerNames);
    // Give a wrongly attempted detached send time to land.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(linksTo(sender, account.email)).toHaveLength(1);
    expect(await tokenRows(account.userId), 'no token issued, none deleted or changed').toEqual(
      reference.rows,
    );
    expect(await store().lookup(reference.earlier.id, reference.earlier.token)).toMatchObject({
      status: 'found',
    });
  }

  it('A suppressed request leaves the earlier link valid: a full recipient cap', async () => {
    const sender = createRecordingEmailSender();
    const app = await makeApp(sender, {
      passwordResetRecipientCap: { max: 1, windowSeconds: 3600 },
    });
    const account = await createAccount(app);
    const reference = await holdAValidLink(app, sender, account);

    const answer = await post(app, account.email);

    await expectSuppressedAndEarlierLinkValid({ sender, account, reference, answer });
  }, 120_000);

  it('A suppressed request leaves the earlier link valid: the kill switch turned on', async () => {
    const senderBefore = createRecordingEmailSender();
    const senderKilled = createRecordingEmailSender();
    const open = await makeApp(senderBefore);
    const killed = await makeApp(senderKilled, { killSwitch: true });
    const account = await createAccount(open);
    const reference = await holdAValidLink(open, senderBefore, account);

    const answer = await post(killed, account.email);

    await expectSuppressedAndEarlierLinkValid({
      sender: senderBefore,
      account,
      reference,
      answer,
    });
    expect(senderKilled.sent).toHaveLength(0);
  }, 120_000);

  it('A suppressed request leaves the earlier link valid: every tenant of the user disabled', async () => {
    const senderBefore = createRecordingEmailSender();
    const senderDisabled = createRecordingEmailSender();
    const open = await makeApp(senderBefore);
    const account = await createAccount(open);
    const reference = await holdAValidLink(open, senderBefore, account);
    const disabled = await makeApp(senderDisabled, { disabledTenantIds: [account.tenantId] });

    const answer = await post(disabled, account.email);

    await expectSuppressedAndEarlierLinkValid({
      sender: senderBefore,
      account,
      reference,
      answer,
    });
    expect(senderDisabled.sent).toHaveLength(0);
  }, 120_000);

  it('A suppressed request leaves the earlier link valid: a recipient domain off the allowlist', async () => {
    const senderBefore = createRecordingEmailSender();
    const senderListed = createRecordingEmailSender();
    const open = await makeApp(senderBefore);
    const listed = await makeApp(senderListed, { recipientDomainAllowlist: ['allowed.example'] });
    const account = await createAccount(open);
    const reference = await holdAValidLink(open, senderBefore, account);

    const answer = await post(listed, account.email);

    await expectSuppressedAndEarlierLinkValid({
      sender: senderBefore,
      account,
      reference,
      answer,
    });
    expect(senderListed.sent).toHaveLength(0);
  }, 120_000);

  it('The newest link wins: after two admitted requests the first link is the uniform rejection and the second still works', async () => {
    const sender = createRecordingEmailSender();
    const app = await makeApp(sender);
    const account = await createAccount(app);

    expect((await post(app, account.email)).status).toBe(200);
    await vi.waitFor(() => {
      expect(linksTo(sender, account.email)).toHaveLength(1);
    });
    expect((await post(app, account.email)).status).toBe(200);
    await vi.waitFor(() => {
      expect(linksTo(sender, account.email)).toHaveLength(2);
    });

    const [first, second] = linksTo(sender, account.email) as [
      { id: string; token: string },
      { id: string; token: string },
    ];
    expect(first.id).not.toBe(second.id);
    expect(await store().lookup(first.id, first.token)).toEqual({ status: 'not_found' });
    expect(await store().lookup(second.id, second.token)).toMatchObject({ status: 'found' });
    expect(await tokenRows(account.userId)).toHaveLength(1);
  }, 120_000);

  it('a token-store failure after admission still answers the uniform 200 and logs token_issue_failure', async () => {
    const sender = createRecordingEmailSender();
    const app = await makeApp(sender, {}, failingInsertPool(authPool));
    const account = await createAccount(app);
    const reference = await post(app, `ghost-${randomUUID()}@example.test`);
    await harness.reset();

    failTokenInsert = true;
    const answer = await post(app, account.email);
    failTokenInsert = false;

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ accepted: true });
    expect(answer.headerNames).toEqual(reference.headerNames);
    await harness.forceFlush();
    const events = harness.logExporter
      .getFinishedLogRecords()
      .filter((record) => record.eventName === 'catalog.security.recovery_email_suppressed');
    expect(events).toHaveLength(1);
    expect(events[0]?.attributes['tayzu.identity.recovery.suppression']).toBe(
      'token_issue_failure',
    );
    expect(JSON.stringify(events[0]?.attributes)).not.toContain(account.email);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sender.sent.filter((message) => message.to === account.email)).toHaveLength(0);
    expect(await tokenRows(account.userId)).toHaveLength(0);
  }, 120_000);
});

/**
 * Task 6.4 (design D4 "Detached send" and "Padding", D9 `PASSWORD_RESET_MIN_RESPONSE_MS`):
 * scenario "A slow provider does not slow the response" of
 * `specs/password-reset-and-account-recovery/spec.md`, and the case "an unknown and an eligible
 * address both return at the minimum duration, not before".
 *
 * Scenario (verbatim from the spec): GIVEN an eligible account and a sender that takes two seconds
 * to answer; WHEN the address is posted to the request route; THEN the response is returned
 * without waiting for the sender, and no sooner than the fixed minimum duration.
 *
 * ## Harness
 *
 * The timers and `performance` are faked (`setTimeout`, `clearTimeout`, `performance`; never
 * `setImmediate`, so the real database I/O and the real-time yields below keep working). The slow
 * sender resolves on a faked `setTimeout(2000)`, so it finishes only when the test advances the
 * clock. The fake clock is advanced in 50 ms steps, yielding real time after each step so the
 * promise chains settle; the response is "settled" when the injected request has resolved.
 * Accounts are created before the clock is faked.
 *
 * ## Production symbols expected
 *
 * - The request route (`server.ts`) computes its answer, then waits until
 *   `PASSWORD_RESET_MIN_RESPONSE_MS` (400 by default) has elapsed on `performance.now()` since the
 *   handler started, with a timer, for every branch (also the `400` answers are outside this
 *   requirement; only the `200` path is observed here).
 * - `CreateAppOptions.email.passwordResetMinResponseMs?: number` carries the value (passed here as
 *   400, equal to the default, through a variable so this file type-checks before it exists).
 * - The send is detached: the handler never awaits `mailer.send(link)`.
 */
describe('The minimum response duration and the detached send (task 6.4)', () => {
  const MIN_MS = 400;
  const SLOW_SENDER_MS = 2000;
  const STEP_MS = 50;

  let app: App;
  let sender: ReturnType<typeof createRecordingEmailSender>;
  let senderCalls: number;
  let slowSenderDone: boolean;
  let slow: boolean;

  beforeAll(async () => {
    const pools = await harnessPools();
    sender = createRecordingEmailSender();
    senderCalls = 0;
    slowSenderDone = false;
    slow = false;
    const timedSender = {
      send: async (to: string, template: never): Promise<void> => {
        senderCalls += 1;
        if (slow) {
          await new Promise<void>((resolve) => setTimeout(resolve, SLOW_SENDER_MS));
          slowSenderDone = true;
        }
        await (sender as { send: (to: string, template: never) => Promise<void> }).send(
          to,
          template,
        );
      },
    };
    const email = {
      sender: timedSender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      passwordResetMinResponseMs: MIN_MS,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
      passwordResetRecipientCap: { max: 1000, windowSeconds: 3600 },
      passwordResetIpCap: { max: 1000, windowSeconds: 3600 },
      passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
    };
    app = await createApp({
      appPool: pools.appPool,
      authPool: pools.authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    await app.close();
  }, 60_000);

  beforeEach(() => {
    slow = false;
    slowSenderDone = false;
  });

  async function createAccount(): Promise<string> {
    const suffix = randomUUID();
    const email = `padding-${suffix}@example.test`;
    await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Padding User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Padding Org ${suffix}`,
      organizationSlug: `padding-${suffix}`,
      ip: randomIp(),
    });
    return email;
  }

  /** Yields real time (setImmediate is not faked) for `ms` milliseconds of wall clock. */
  async function yieldReal(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  /**
   * Posts under the fake clock and reports the fake time (a multiple of STEP_MS) at which the
   * response settled, and whether the slow sender had finished by then.
   */
  async function timedPost(
    address: string,
    waitForSend: boolean,
  ): Promise<{ status: number; body: unknown; settledAtMs: number; senderDone: boolean }> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      let settled:
        { status: number; body: unknown; settledAtMs: number; senderDone: boolean } | undefined;
      let fakeElapsed = 0;
      const pending = app.app
        .inject({
          method: 'POST',
          url: REQUEST_PATH,
          headers: {
            'content-type': 'application/json',
            origin: ORIGIN,
            'x-csrf-token': 'orpc',
            'x-forwarded-for': randomIp(),
          },
          payload: JSON.stringify({ email: address }),
        })
        .then((response) => {
          settled = {
            status: response.statusCode,
            body: response.json(),
            settledAtMs: fakeElapsed,
            senderDone: slowSenderDone,
          };
        });

      // Let the handler finish its real work (database) with the clock standing still.
      const deadline = Date.now() + 10_000;
      if (waitForSend) {
        while (senderCalls === 0 && Date.now() < deadline) await yieldReal(10);
      }
      await yieldReal(500);

      while (settled === undefined && fakeElapsed < SLOW_SENDER_MS + 1000) {
        fakeElapsed += STEP_MS;
        await vi.advanceTimersByTimeAsync(STEP_MS);
        await yieldReal(100);
      }
      await pending;
      if (settled === undefined) throw new Error('the response never settled');
      return settled;
    } finally {
      // Let any slow send finish before the real clock returns.
      await vi.advanceTimersByTimeAsync(SLOW_SENDER_MS);
      await yieldReal(100);
      vi.useRealTimers();
    }
  }

  it('A slow provider does not slow the response: with a sender that takes two seconds, the 200 returns at the minimum duration, before the sender is done', async () => {
    const address = await createAccount();
    slow = true;
    senderCalls = 0;

    const result = await timedPost(address, true);

    expect(senderCalls, 'the send was started').toBe(1);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ accepted: true });
    expect(result.settledAtMs, 'not before the minimum duration').toBeGreaterThanOrEqual(MIN_MS);
    expect(result.settledAtMs, 'without waiting for the sender').toBeLessThan(SLOW_SENDER_MS);
    expect(result.senderDone, 'the sender was still running when the response returned').toBe(
      false,
    );

    // The detached send still completes and delivers the mail.
    await vi.waitFor(() => {
      expect(
        sender.sent.filter((m) => m.to === address && m.template.kind === 'PasswordResetEmail'),
      ).toHaveLength(1);
    });
  }, 120_000);

  it('an unknown and an eligible address both return at the minimum duration, not before', async () => {
    const eligible = await createAccount();
    const ghost = `ghost-${randomUUID()}@example.test`;
    senderCalls = 0;

    const eligibleResult = await timedPost(eligible, true);
    const ghostResult = await timedPost(ghost, false);

    for (const result of [eligibleResult, ghostResult]) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ accepted: true });
      expect(result.settledAtMs, 'not before the minimum duration').toBeGreaterThanOrEqual(MIN_MS);
      expect(result.settledAtMs, 'padded to the minimum, not beyond').toBeLessThan(
        MIN_MS + STEP_MS * 2,
      );
    }
  }, 120_000);
});

/**
 * Task 6.5 (design D2 "CSRF and `Origin`" and "Request-route refusals (Q24)"): scenarios "A
 * cross-site request is refused before any lookup" and "The client cannot choose where the link
 * points" of `specs/password-reset-and-account-recovery/spec.md`.
 *
 * Scenarios (verbatim from the spec):
 * - "A cross-site request is refused before any lookup": WHEN the request route receives a valid
 *   body without the CSRF header, or from an `Origin` that is not allowed; THEN it answers
 *   `CATALOG_VALIDATION_FAILED`, performs no account lookup and sends no email.
 * - "The client cannot choose where the link points": WHEN the request route receives a
 *   `redirectTo` or `callbackURL` field; THEN it answers `CATALOG_VALIDATION_FAILED`.
 *
 * Q24: these answers are `400`, not the uniform `200` (they depend only on the request).
 *
 * ## Harness
 *
 * The real server with the identity routes mounted, over a recording sender and a spy on the
 * `tayzu_auth` pool (as task 6.1). The body is the address of a real, eligible account, so a
 * request that wrongly passed the check would look the account up and send mail. Every request
 * carries a fresh random `x-forwarded-for`.
 *
 * ## Production symbols expected
 *
 * - The request route (`server.ts`) requires `x-csrf-token: orpc` and an `Origin` in
 *   `ALLOWED_ORIGINS` (`allowedOrigins`), and otherwise answers `400 CATALOG_VALIDATION_FAILED`
 *   before the strict parse, any lookup or any send. No new export.
 */
describe('CSRF header, Origin and redirectTo on the request route (task 6.5)', () => {
  let app: App;
  let sender: ReturnType<typeof createRecordingEmailSender>;
  let statements: string[];
  let knownEmail: string;

  beforeAll(async () => {
    const pools = await harnessPools();
    statements = [];
    sender = createRecordingEmailSender();
    const email = {
      sender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
      passwordResetRecipientCap: { max: 1000, windowSeconds: 3600 },
      passwordResetIpCap: { max: 1000, windowSeconds: 3600 },
      passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
    };
    app = await createApp({
      appPool: pools.appPool,
      authPool: spyOnPool(pools.authPool, (sql) => statements.push(sql)),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });
    const suffix = randomUUID();
    knownEmail = `csrf-${suffix}@example.test`;
    await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Csrf User',
      email: knownEmail,
      password: TEST_PASSWORD,
      organizationName: `Csrf Org ${suffix}`,
      organizationSlug: `csrf-${suffix}`,
      ip: randomIp(),
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  async function postWith(
    headers: Record<string, string>,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const response = await app.app.inject({
      method: 'POST',
      url: REQUEST_PATH,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        ...headers,
      },
      payload: JSON.stringify(payload),
    });
    return { status: response.statusCode, body: response.json() };
  }

  async function expectRefusedBeforeAnyLookup(
    headers: Record<string, string>,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const sentBefore = sender.sent.length;
    const before = statements.length;

    const answer = await postWith(headers, payload);

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(answer.body).not.toEqual({ accepted: true });
    const lookups = statements.slice(before).filter((sql) => ACCOUNT_TABLES.test(sql));
    expect(lookups, 'no statement touched the account tables').toEqual([]);
    // Give a wrongly attempted detached send time to land.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sender.sent).toHaveLength(sentBefore);
  }

  it('control: a same-site request for the same address does look the account up and mails it', async () => {
    const before = statements.length;

    const answer = await postWith(
      { origin: ORIGIN, 'x-csrf-token': 'orpc' },
      { email: knownEmail },
    );

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ accepted: true });
    expect(
      statements.slice(before).filter((sql) => ACCOUNT_TABLES.test(sql)).length,
    ).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(
        sender.sent.filter((m) => m.to === knownEmail && m.template.kind === 'PasswordResetEmail'),
      ).toHaveLength(1);
    });
  });

  describe('A cross-site request is refused before any lookup', () => {
    it('a valid body without the x-csrf-token header: CATALOG_VALIDATION_FAILED, no lookup, no email', async () => {
      await expectRefusedBeforeAnyLookup({ origin: ORIGIN }, { email: knownEmail });
    });

    it('a valid body with a wrong x-csrf-token value: CATALOG_VALIDATION_FAILED, no lookup, no email', async () => {
      await expectRefusedBeforeAnyLookup(
        { origin: ORIGIN, 'x-csrf-token': 'not-orpc' },
        { email: knownEmail },
      );
    });

    it('a valid body from an Origin that is not allowed: CATALOG_VALIDATION_FAILED, no lookup, no email', async () => {
      await expectRefusedBeforeAnyLookup(
        { origin: 'https://evil.example', 'x-csrf-token': 'orpc' },
        { email: knownEmail },
      );
    });

    it('a valid body with no Origin header: CATALOG_VALIDATION_FAILED, no lookup, no email', async () => {
      await expectRefusedBeforeAnyLookup({ 'x-csrf-token': 'orpc' }, { email: knownEmail });
    });
  });

  describe('The client cannot choose where the link points', () => {
    for (const field of ['redirectTo', 'callbackURL']) {
      it(`a ${field} field: CATALOG_VALIDATION_FAILED, no lookup, no email`, async () => {
        await expectRefusedBeforeAnyLookup(
          { origin: ORIGIN, 'x-csrf-token': 'orpc' },
          { email: knownEmail, [field]: 'https://evil.example/steal' },
        );
      });
    }
  });
});

/**
 * Task 6.7 (design D2, constraint C6): scenario "Reset responses are not cacheable" of
 * `specs/password-reset-and-account-recovery/spec.md`, for the request route.
 *
 * Scenario (verbatim): WHEN either reset route answers a success, a refusal or a rate-limit
 * response; THEN the response carries `Cache-Control: no-store` and `Pragma: no-cache`.
 *
 * Cases: success (an eligible account), the uniform answer (an unknown address), a validation
 * refusal (malformed body, and a cross-site request), the limiter `429`, and the fail-closed `500`
 * (the `auth.rate_limit` store throws).
 *
 * ## Harness
 *
 * The real server with the identity routes mounted over a recording sender; the `tayzu_auth` pool
 * is wrapped so that, while a flag is on, any statement touching `rate_limit` throws. Every
 * request carries a fresh random `x-forwarded-for` (except the limiter case, which reuses one).
 *
 * ## Production symbols expected
 *
 * - A helper (for example `applyNoCacheHeaders(reply)` in `./identity/no-cache.ts`) that sets
 *   `Pragma: no-cache`, called on every response of the request route, including the pre-handler
 *   refusals. `Cache-Control: no-store` is already set by the app on every response. The tests
 *   observe only headers, so the helper's name and path are the implementer's choice.
 */
describe('Reset responses are not cacheable (task 6.7)', () => {
  let app: App;
  let knownEmail: string;
  let failStore = false;

  beforeAll(async () => {
    const pools = await harnessPools();
    const sender = createRecordingEmailSender();
    const authPool = spyOnPool(pools.authPool, (sql) => {
      if (failStore && /rate_limit/i.test(sql)) throw new Error('store down');
    });
    const email = {
      sender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      passwordResetMinResponseMs: 0,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
    };
    app = await createApp({
      appPool: pools.appPool,
      authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });
    const suffix = randomUUID();
    knownEmail = `cache-${suffix}@example.test`;
    await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Cache User',
      email: knownEmail,
      password: TEST_PASSWORD,
      organizationName: `Cache Org ${suffix}`,
      organizationSlug: `cache-${suffix}`,
      ip: randomIp(),
    });
  }, 60_000);

  afterAll(async () => {
    failStore = false;
    await app.close();
  }, 60_000);

  async function postRaw(
    payload: string,
    overrides: { ip?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; cacheControl: unknown; pragma: unknown }> {
    const response = await app.app.inject({
      method: 'POST',
      url: REQUEST_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': overrides.ip ?? randomIp(),
        ...overrides.headers,
      },
      payload,
    });
    return {
      status: response.statusCode,
      cacheControl: response.headers['cache-control'],
      pragma: response.headers['pragma'],
    };
  }

  function expectNotCacheable(answer: { cacheControl: unknown; pragma: unknown }): void {
    expect(String(answer.cacheControl)).toContain('no-store');
    expect(answer.pragma).toBe('no-cache');
  }

  it('a success (an eligible account): 200 with Cache-Control: no-store and Pragma: no-cache', async () => {
    const answer = await postRaw(JSON.stringify({ email: knownEmail }));

    expect(answer.status).toBe(200);
    expectNotCacheable(answer);
  });

  it('the uniform answer (an unknown address): 200 with Cache-Control: no-store and Pragma: no-cache', async () => {
    const answer = await postRaw(JSON.stringify({ email: `ghost-${randomUUID()}@example.test` }));

    expect(answer.status).toBe(200);
    expectNotCacheable(answer);
  });

  it('a validation refusal (malformed body): 400 with Cache-Control: no-store and Pragma: no-cache', async () => {
    const answer = await postRaw(JSON.stringify({ email: 12_345 }));

    expect(answer.status).toBe(400);
    expectNotCacheable(answer);
  });

  it('a validation refusal (cross-site request): 400 with Cache-Control: no-store and Pragma: no-cache', async () => {
    const answer = await postRaw(JSON.stringify({ email: knownEmail }), {
      headers: { origin: 'https://evil.example' },
    });

    expect(answer.status).toBe(400);
    expectNotCacheable(answer);
  });

  it('the limiter 429: Cache-Control: no-store and Pragma: no-cache', async () => {
    const ip = randomIp();
    for (let index = 0; index < 10; index += 1) {
      const admitted = await postRaw(JSON.stringify({ email: `g-${randomUUID()}@example.test` }), {
        ip,
      });
      expect(admitted.status, `request ${String(index + 1)}`).toBe(200);
    }

    const limited = await postRaw(JSON.stringify({ email: `g-${randomUUID()}@example.test` }), {
      ip,
    });

    expect(limited.status).toBe(429);
    expectNotCacheable(limited);
  });

  it('the fail-closed 500: Cache-Control: no-store and Pragma: no-cache', async () => {
    failStore = true;
    try {
      const answer = await postRaw(JSON.stringify({ email: knownEmail }));

      expect(answer.status).toBe(500);
      expectNotCacheable(answer);
    } finally {
      failStore = false;
    }
  });
});

/**
 * Fix cycle 16.3a under task 16.3 (design D4 "Dependency failures (Q35)" and "Padding", D5
 * "Admission before issue", D15, Resolved decision Q35): scenario "A dependency failure is
 * invisible to the caller" of `specs/password-reset-and-account-recovery/spec.md`.
 *
 * Scenario (verbatim from the spec): GIVEN an eligible account, and a status read of the
 * eligibility check that fails, or a cap store that fails with an error that is not a full cap;
 * WHEN the address is posted to the request route; THEN the answer is the uniform one, returned no
 * sooner than the fixed minimum duration, no token is issued and no email is sent; AND
 * `catalog.security.recovery_email_suppressed` is logged with the reason `dependency_failure` and
 * no address.
 *
 * Design D4 (verbatim): "The request flow (`password-reset-request.ts`) therefore catches a
 * failure of the eligibility check, and a failure of the admission that is not a cap refusal, logs
 * `catalog.security.recovery_email_suppressed` once with the reason `dependency_failure`, counts
 * the request as `suppressed`, issues no token, deletes none, sends nothing, and returns normally,
 * so the handler pads and answers the uniform `200` like every other account-dependent branch. The
 * event carries the user id when the admission failed (the user is known and eligible) and none
 * when the eligibility check failed (the address may be unknown). The caught error itself goes to
 * no signal and no response: only the closed reason leaves the flow."
 *
 * ## Harness
 *
 * One real server with the identity routes mounted, a 400 ms minimum, roomy caps and a recording
 * sender, over two wrapped pools. A failure is armed for one request only, and injected at the
 * statement level:
 *
 * - `status_read` (case a): on the `tayzu_app` pool, every statement that touches a `catalog_*`
 *   table rejects, so `userSync.readStatus` fails. It is injected only after the user lookup was
 *   seen on the `tayzu_auth` pool, so the first lookup succeeds.
 * - `cap_store` (case b): on the `tayzu_auth` pool, every statement that touches
 *   `auth.rate_limit` rejects, but only after the request's user lookup. The route limiter writes
 *   the same table in its pre-handler, before any lookup, so it still passes: the failure hits
 *   only the cap store of the mailer's admission. The control assertions (the lookup was seen and
 *   the failure was injected) prove the request reached the handler, so the answer observed is
 *   not the limiter's fail-closed `500`.
 * - `membership_read` (case c): on the `tayzu_auth` pool, the read of `auth.member` rejects
 *   after the user lookup.
 *
 * The injected error's message is a unique marker plus the recipient address. Each request is
 * posted under the fake clock of task 6.4 (`setTimeout`, `clearTimeout` and `performance` only),
 * and compared with an unknown address posted the same way to the same app. "No token is issued,
 * none deleted" is observed as in task 6.3: the user's `password-reset:` rows are exactly the row
 * of a link the user held before the failure, and that link is still found.
 *
 * ## Production symbols expected
 *
 * - `createPasswordResetRequestFlow(...).handle` (`./identity/password-reset-request.ts`) catches
 *   a failure of `eligibility.check` and a failure of `mailer.admitResetEmail` that is not a cap
 *   refusal, emits the suppression once (`tayzu.identity.email.template` = `password_reset`,
 *   `tayzu.identity.recovery.suppression` = `dependency_failure`; `tayzu.identity.user.id` only
 *   when the admission failed), records `tayzu.identity.password_reset_requests` with the outcome
 *   `suppressed`, and returns normally. No new export.
 * - `dependency_failure` joins `tayzu.identity.recovery.suppression` in
 *   `packages/auth/src/telemetry/identity-contract.ts`.
 */
describe('A dependency failure is invisible to the caller (task 16.3, design D4, Q35)', () => {
  const MIN_MS = 400;
  const STEP_MS = 50;
  const EVENT_SUPPRESSED = 'catalog.security.recovery_email_suppressed';
  const EVENT_REQUESTED = 'catalog.audit.password_reset_requested';
  const METRIC_REQUESTS = 'tayzu.identity.password_reset_requests';
  const REQUEST_OUTCOME = 'tayzu.identity.reset.request_outcome';
  const SUPPRESSION = 'tayzu.identity.recovery.suppression';
  const EMAIL_TEMPLATE = 'tayzu.identity.email.template';
  const USER_ID = 'tayzu.identity.user.id';

  type Failure = 'status_read' | 'cap_store' | 'membership_read';
  type Attributes = Readonly<Record<string, unknown>>;

  interface TimedAnswer extends Answer {
    /** The fake time (a multiple of STEP_MS) at which the response settled. */
    readonly settledAtMs: number;
    /** The header values and the raw body, to search for what must not leave the flow. */
    readonly text: string;
  }

  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let app: App;
  let sender: ReturnType<typeof createRecordingEmailSender>;

  let armed: Failure | undefined;
  let failureMessage = '';
  let lookupSeen = false;
  let injected = 0;

  /** Rejects the statements `fails` selects, counting each injection; every other one passes. */
  function failingPool(pool: Pool, fails: (sql: string) => boolean): Pool {
    const guard = (first: unknown, run: () => unknown): unknown => {
      if (!fails(statementText(first))) return run();
      injected += 1;
      return Promise.reject(new Error(failureMessage));
    };
    const wrapClient = (client: PoolClient): PoolClient =>
      new Proxy(client, {
        get(target, property): unknown {
          const value: unknown = Reflect.get(target, property, target);
          if (property === 'query') {
            return (...args: unknown[]): unknown =>
              guard(args[0], () => (value as QueryFunction).apply(target, args));
          }
          return typeof value === 'function' ? (value as QueryFunction).bind(target) : value;
        },
      });
    return new Proxy(pool, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'query') {
          return (...args: unknown[]): unknown =>
            guard(args[0], () => (value as QueryFunction).apply(target, args));
        }
        if (property === 'connect') {
          return async (): Promise<PoolClient> => wrapClient(await target.connect());
        }
        return typeof value === 'function' ? (value as QueryFunction).bind(target) : value;
      },
    });
  }

  /** The `tayzu_auth` pool: notes the user lookup, then fails what the armed failure names. */
  function authStatementFails(sql: string): boolean {
    if (armed === undefined) return false;
    if (/from\s+auth\."user"/i.test(sql)) {
      lookupSeen = true;
      return false;
    }
    if (!lookupSeen) return false;
    if (armed === 'cap_store') return /rate_limit/i.test(sql);
    if (armed === 'membership_read') return /from\s+auth\.member\b/i.test(sql);
    return false;
  }

  /** The `tayzu_app` pool: the `_user` status read fails, after the user lookup on the other pool. */
  function appStatementFails(sql: string): boolean {
    return armed === 'status_read' && lookupSeen && /catalog_/i.test(sql);
  }

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    authPool = pools.authPool;
    sender = createRecordingEmailSender();
    const roomy = { max: 1000, windowSeconds: 3600 };
    const email = {
      sender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      passwordResetMinResponseMs: MIN_MS,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: roomy,
      recipientCap: { max: 1000, windowSeconds: 86_400 },
      passwordResetRecipientCap: roomy,
      passwordResetIpCap: roomy,
      passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
    };
    app = await createApp({
      appPool: failingPool(pools.appPool, appStatementFails),
      authPool: failingPool(pools.authPool, authStatementFails),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });
  }, 60_000);

  beforeEach(() => {
    armed = undefined;
  });

  afterAll(async () => {
    armed = undefined;
    vi.useRealTimers();
    await app.close();
  }, 60_000);

  async function createAccount(): Promise<{ email: string; userId: string }> {
    const suffix = randomUUID();
    const email = `dependency-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Dependency User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Dependency Org ${suffix}`,
      organizationSlug: `dependency-${suffix}`,
      ip: randomIp(),
    });
    return { email, userId: tenant.userId };
  }

  async function tokenRows(userId: string): Promise<{ identifier: string; value: string }[]> {
    const result = await authPool.query<{ identifier: string; value: string }>(
      `select identifier, value from auth.verification
        where identifier like 'password-reset:%' and split_part(value, ':', 3) = $1
        order by identifier`,
      [userId],
    );
    return result.rows;
  }

  function linksTo(address: string): { id: string; token: string }[] {
    const links: { id: string; token: string }[] = [];
    for (const message of sender.sent) {
      if (message.to !== address || message.template.kind !== 'PasswordResetEmail') continue;
      const fragment = new URLSearchParams(new URL(message.template.link).hash.slice(1));
      links.push({ id: fragment.get('reset') ?? '', token: fragment.get('token') ?? '' });
    }
    return links;
  }

  function store() {
    return createResetTokenStore({ authPool, withUserLock: createWithUserLock(authPool) });
  }

  function headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      origin: ORIGIN,
      'x-csrf-token': 'orpc',
      'x-forwarded-for': randomIp(),
    };
  }

  /** The GIVEN of an eligible account: its first request is admitted, mailed and its link works. */
  async function holdAValidLink(account: { email: string; userId: string }) {
    const response = await app.app.inject({
      method: 'POST',
      url: REQUEST_PATH,
      headers: headers(),
      payload: JSON.stringify({ email: account.email }),
    });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(linksTo(account.email)).toHaveLength(1);
    });
    const [link] = linksTo(account.email);
    if (link === undefined) throw new Error('unreachable');
    const rows = await tokenRows(account.userId);
    expect(rows).toHaveLength(1);
    expect(await store().lookup(link.id, link.token)).toMatchObject({ status: 'found' });
    return { link, rows };
  }

  /** Yields real time (setImmediate is not faked) for `ms` milliseconds of wall clock. */
  async function yieldReal(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  /**
   * The technique of task 6.4: posts under the fake clock, lets the handler finish its real work
   * with the clock standing still, then advances the clock in STEP_MS steps until the response
   * settles, and reports the fake time at which it did.
   */
  async function timedPost(address: string): Promise<TimedAnswer> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      let settled: TimedAnswer | undefined;
      let fakeElapsed = 0;
      const pending = app.app
        .inject({
          method: 'POST',
          url: REQUEST_PATH,
          headers: headers(),
          payload: JSON.stringify({ email: address }),
        })
        .then((response) => {
          let body: unknown;
          try {
            body = response.json();
          } catch {
            body = response.body;
          }
          settled = {
            status: response.statusCode,
            body,
            headerNames: Object.keys(response.headers).sort(),
            settledAtMs: fakeElapsed,
            text: `${JSON.stringify(response.headers)}\n${response.body}`,
          };
        });

      await yieldReal(500);
      while (settled === undefined && fakeElapsed < MIN_MS * 5) {
        fakeElapsed += STEP_MS;
        await vi.advanceTimersByTimeAsync(STEP_MS);
        await yieldReal(100);
      }
      await pending;
      if (settled === undefined) throw new Error('the response never settled');
      return settled;
    } finally {
      await vi.advanceTimersByTimeAsync(MIN_MS * 2);
      await yieldReal(100);
      vi.useRealTimers();
    }
  }

  interface Signals {
    readonly spans: readonly {
      readonly name: string;
      readonly attributes: Attributes;
      readonly status: unknown;
      readonly events: readonly { readonly name: string; readonly attributes: unknown }[];
    }[];
    readonly logs: readonly {
      readonly name: string;
      readonly body: unknown;
      readonly attributes: Attributes;
    }[];
    readonly points: readonly {
      readonly name: string;
      readonly attributes: Attributes;
      readonly value: number;
    }[];
  }

  async function signals(): Promise<Signals> {
    await harness.forceFlush();
    const spans = harness.spanExporter.getFinishedSpans().map((span) => ({
      name: span.name,
      attributes: { ...span.attributes },
      status: span.status,
      events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
    }));
    const logs = [...harness.logExporter.getFinishedLogRecords()].map((record) => ({
      name: record.eventName ?? '',
      body: record.body,
      attributes: { ...record.attributes },
    }));
    const points: { name: string; attributes: Attributes; value: number }[] = [];
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          for (const point of metric.dataPoints) {
            const value: unknown = point.value;
            points.push({
              name: metric.descriptor.name,
              attributes: { ...point.attributes },
              value: typeof value === 'number' ? value : 0,
            });
          }
        }
      }
    }
    return { spans, logs, points };
  }

  function requestsCounted(all: Signals, outcome: string): number {
    return all.points
      .filter(
        (point) => point.name === METRIC_REQUESTS && point.attributes[REQUEST_OUTCOME] === outcome,
      )
      .reduce((sum, point) => sum + point.value, 0);
  }

  /**
   * GIVEN an eligible account that holds a valid link, and the armed dependency failure; WHEN the
   * address is posted; THEN and AND are asserted here, for each of the three failures alike.
   */
  async function expectInvisibleToTheCaller(
    failure: Failure,
    userIdOnTheEvent: 'present' | 'absent',
  ): Promise<void> {
    const account = await createAccount();
    const held = await holdAValidLink(account);
    const reference = await timedPost(`ghost-${randomUUID()}@example.test`);
    const sentBefore = sender.sent.length;
    const marker = `dependency-failure-marker-${randomUUID()}`;
    await harness.reset();

    failureMessage = `${marker} for ${account.email}`;
    lookupSeen = false;
    injected = 0;
    armed = failure;
    let answer: TimedAnswer;
    try {
      answer = await timedPost(account.email);
    } finally {
      armed = undefined;
    }

    // Controls: the request passed the route limiter and reached the handler (the user lookup
    // ran), and the armed dependency really failed after it.
    expect(lookupSeen, 'control: the handler looked the user up').toBe(true);
    expect(
      injected,
      'control: the armed dependency failed, after the user lookup',
    ).toBeGreaterThanOrEqual(1);

    // THEN the answer is the uniform one: that of an unknown address posted to the same app.
    expect(reference.status).toBe(200);
    expect(reference.body).toEqual({ accepted: true });
    expect(answer.status).toBe(reference.status);
    expect(answer.body).toEqual(reference.body);
    expect(answer.headerNames).toEqual(reference.headerNames);

    // ... returned no sooner than the fixed minimum duration.
    expect(
      reference.settledAtMs,
      'the unknown address: not before the minimum',
    ).toBeGreaterThanOrEqual(MIN_MS);
    expect(answer.settledAtMs, 'not before the minimum duration').toBeGreaterThanOrEqual(MIN_MS);

    // ... no email is sent (give a wrongly attempted detached send time to land).
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sender.sent, 'nothing reached the sender').toHaveLength(sentBefore);

    // ... no token is issued, and none is deleted: the earlier link is still found.
    expect(await tokenRows(account.userId), 'no token issued, none deleted or changed').toEqual(
      held.rows,
    );
    expect(await store().lookup(held.link.id, held.link.token)).toMatchObject({
      status: 'found',
    });

    // AND the suppression is logged once, with the closed reason and no address.
    const all = await signals();
    const suppressions = all.logs.filter((record) => record.name === EVENT_SUPPRESSED);
    expect(suppressions, `exactly one "${EVENT_SUPPRESSED}"`).toHaveLength(1);
    const suppression = suppressions[0]?.attributes ?? {};
    expect(suppression[EMAIL_TEMPLATE]).toBe('password_reset');
    expect(suppression[SUPPRESSION]).toBe('dependency_failure');
    if (userIdOnTheEvent === 'present') {
      expect(suppression[USER_ID], 'the admission failed: the user is known').toBe(account.userId);
    } else {
      expect(
        Object.keys(suppression),
        'the eligibility check failed: the address may be unknown',
      ).not.toContain(USER_ID);
    }
    expect(JSON.stringify(suppressions)).not.toContain(account.email);

    // The request counts once, as `suppressed`, and nothing was issued.
    expect(requestsCounted(all, 'suppressed')).toBe(1);
    expect(requestsCounted(all, 'issued')).toBe(0);
    expect(requestsCounted(all, 'ineligible')).toBe(0);
    expect(all.logs.filter((record) => record.name === EVENT_REQUESTED)).toEqual([]);

    // The caught error goes to no signal and no response.
    const exported = JSON.stringify(all);
    expect(exported).not.toContain(marker);
    expect(exported).not.toContain(failureMessage);
    expect(answer.text).not.toContain(marker);
    expect(answer.text).not.toContain(account.email);
  }

  it('a userSync.readStatus failure for an eligible address answers the uniform 200 after the minimum duration and logs a suppression', async () => {
    await expectInvisibleToTheCaller('status_read', 'absent');
  }, 120_000);

  it('a cap-store error that is not a rate-limit refusal answers the same', async () => {
    await expectInvisibleToTheCaller('cap_store', 'present');
  }, 120_000);

  it('an auth-schema read of the eligibility check that fails after the user lookup answers the same', async () => {
    await expectInvisibleToTheCaller('membership_read', 'absent');
  }, 120_000);
});
