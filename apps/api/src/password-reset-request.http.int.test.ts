/**
 * Task 6.1 of openspec/changes/044-password-reset-and-account-recovery (design D2 "The routes"
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
import { randomInt, randomUUID } from 'node:crypto';

import { createRecordingEmailSender } from '@tayzu/auth';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  seedUserRow,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
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
