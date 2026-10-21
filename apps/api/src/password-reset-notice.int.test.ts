/**
 * Task 8.12 of openspec/changes/044-password-reset-and-account-recovery (design D7 "After the
 * commit", D8 "The notices").
 *
 * The password-changed notice of a completed reset. Scenarios of
 * `specs/password-reset-and-account-recovery/spec.md`, quoted:
 *
 * - Requirement "Recovery notices are fixed and carry no link": the platform MUST send a fixed
 *   notice to the registered address of a user when their password is changed through a completed
 *   reset; "Each notice MUST have ... exactly one recipient"; "A notice MUST NOT block the
 *   operation that triggered it and MUST NOT be sent when the operation fails."
 * - "A failing provider never breaks the operation": GIVEN a provider that fails; WHEN a user
 *   changes their password; THEN the change succeeds and a suppression is logged without an
 *   address. (Here the password is changed through a completed reset.)
 * - Cases "one `PasswordChangedNotice` is sent to the user's address after the commit", "none is
 *   sent when the transaction rolls back" and "a failing provider leaves the completed reset
 *   completed".
 *
 * ## Harness
 *
 * The real server (`createApp`, injected requests, never a listener) over an instrumented `pg`
 * pool (the `connect` event wraps each physical client's `query`), so the rollback case injects its
 * failure at `commit` after the credential write, as `password-reset-effects.int.test.ts` does.
 * The sender records every message and fails for the addresses a test marks as failing; messages
 * are read by the recipient's random address. Every request carries a fresh random
 * `x-forwarded-for`, `Origin` and `x-csrf-token: orpc`. The breached-password range service is a
 * stubbed global `fetch`. Both global caps are roomy (the shared test database).
 *
 * ## Production symbols expected
 *
 * None new: `createPasswordResetConfirmFlow` (`./identity/password-reset-confirm.js`) sends
 * `{ kind: 'PasswordChangedNotice' }` through the recovery mailer to the user's canonical address
 * after the commit, and a provider failure is logged as `catalog.security.recovery_email_suppressed`
 * (attribute `tayzu.identity.user.id`, no address) without changing the `200 { completed: true }`.
 */
// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import {
  linkLogEvents,
  registration,
  type TelemetryTestHarness,
} from './__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { createRecordingEmailSender, type EmailSender } from '@tayzu/auth';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createResetTokenStore } from './identity/reset-token-store.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const LINK_BASE_URL = 'https://app.tayzu.test';
const CONFIRM_PATH = '/v1/auth/password-reset/confirm';
const HMAC_SECRET = 'reset-notice-test-only-secret-0123456789-abcdef';
const NEW_PASSWORD = 'Another-Perfectly-Fine-Passphrase-77!';
const SUPPRESSED = 'catalog.security.recovery_email_suppressed';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

describe('The password-changed notice of a completed reset (task 8.12)', () => {
  type QueryHook = (client: object, sql: string) => void;

  let harness: TelemetryTestHarness;
  let app: App;
  let authPool: Pool;
  let instrumented: Pool;
  let hook: QueryHook | undefined;
  const recording = createRecordingEmailSender();
  const failingFor = new Set<string>();
  const sender: EmailSender = {
    send(to, template) {
      if (failingFor.has(to)) return Promise.reject(new Error(`provider refused ${to}`));
      return recording.send(to, template);
    },
  };

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    authPool = pools.authPool;

    const url = process.env['DATABASE_URL'];
    if (url === undefined || url.trim() === '') throw new Error('DATABASE_URL is not set');
    instrumented = new Pool({ connectionString: url });
    instrumented.on('connect', (client) => {
      const target = client as unknown as { query: (...args: unknown[]) => unknown };
      const original = target.query.bind(client);
      target.query = (...args: unknown[]): unknown => {
        const first = args[0];
        const sql =
          typeof first === 'string'
            ? first
            : ((first as { text?: string } | undefined)?.text ?? '');
        const last = args[args.length - 1];
        if (hook !== undefined && typeof last !== 'function') {
          try {
            hook(client, sql);
          } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error('hook failed'));
          }
        }
        return original(...args);
      };
    });
    instrumented.on('error', () => undefined);

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
      passwordResetRecipientCap: { max: 1000, windowSeconds: 3600 },
      passwordResetIpCap: { max: 1000, windowSeconds: 3600 },
      passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
      accountCreatedNoticeGlobalCap: { max: 100_000, windowSeconds: 86_400 },
    };
    app = await createApp({
      appPool: pools.appPool,
      authPool: instrumented,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });
  }, 60_000);

  beforeEach(() => {
    vi.stubGlobal('fetch', (): Promise<Response> => {
      return Promise.resolve(
        new Response('0000000000000000000000000000000000A:3\r\n', { status: 200 }),
      );
    });
  });

  afterEach(() => {
    hook = undefined;
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    const giveUp = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([Promise.all([app.close(), instrumented.end()]), giveUp]);
  }, 60_000);

  function store() {
    return createResetTokenStore({ authPool, withUserLock: createWithUserLock(authPool) });
  }

  async function createPerson(): Promise<{ email: string; userId: string }> {
    const suffix = randomUUID();
    const email = `notice-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Notice User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Notice Org ${suffix}`,
      organizationSlug: `notice-${suffix}`,
      ip: randomIp(),
    });
    return { email, userId: tenant.userId };
  }

  async function post(fields: Record<string, unknown>): Promise<Answer> {
    const response = await app.app.inject({
      method: 'POST',
      url: CONFIRM_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify({ newPassword: NEW_PASSWORD, ...fields }),
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body };
  }

  async function passwordHash(userId: string): Promise<string> {
    const result = await authPool.query<{ password: string | null }>(
      `select password from auth.account where user_id = $1 and provider_id = 'credential'`,
      [userId],
    );
    return result.rows[0]?.password ?? '';
  }

  function sentTo(email: string) {
    return recording.sent.filter((message) => message.to === email);
  }

  async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 750));
  }

  describe('Recovery notices are fixed and carry no link', () => {
    it('one PasswordChangedNotice is sent to the user’s address after the commit', async () => {
      const person = await createPerson();
      const issued = await store().issue(person.userId);
      const hashBefore = await passwordHash(person.userId);

      const answer = await post({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ completed: true });
      expect(await passwordHash(person.userId), 'the commit happened').not.toBe(hashBefore);
      await vi.waitFor(() => {
        expect(sentTo(person.email)).toHaveLength(1);
      });
      await settle();
      const sent = sentTo(person.email);
      expect(sent, 'exactly one message, to this one address').toHaveLength(1);
      expect(sent[0]?.template).toEqual({ kind: 'PasswordChangedNotice' });
    }, 60_000);

    it('none is sent when the transaction rolls back', async () => {
      const person = await createPerson();
      const issued = await store().issue(person.userId);
      const hashBefore = await passwordHash(person.userId);

      const wrote = new WeakSet<object>();
      hook = (client, sql) => {
        if (/^\s*update\s+auth\.account\b/i.test(sql)) wrote.add(client);
        if (sql.trim().toLowerCase() === 'commit' && wrote.has(client)) {
          throw new Error('injected failure before the commit');
        }
      };
      const failed = await post({ id: issued.id, token: issued.token });
      hook = undefined;

      expect(failed.status, 'a sanitized internal error').toBe(500);
      expect(await passwordHash(person.userId), 'the password is unchanged').toBe(hashBefore);
      await settle();
      expect(sentTo(person.email), 'a rolled-back reset sends no notice').toHaveLength(0);

      // The same token then completes, and only that completion sends one.
      const retried = await post({ id: issued.id, token: issued.token });
      expect(retried.status).toBe(200);
      await vi.waitFor(() => {
        expect(sentTo(person.email)).toHaveLength(1);
      });
    }, 90_000);
  });

  describe('A failing provider never breaks the operation', () => {
    it('a failing provider leaves the completed reset completed', async () => {
      const person = await createPerson();
      failingFor.add(person.email);
      const issued = await store().issue(person.userId);
      const hashBefore = await passwordHash(person.userId);

      const answer = await post({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ completed: true });
      expect(await passwordHash(person.userId), 'the reset is completed').not.toBe(hashBefore);
      const remaining = await authPool.query(
        'select 1 from auth.verification where identifier = $1',
        [`password-reset:${issued.id}`],
      );
      expect(remaining.rowCount, 'the token is consumed').toBe(0);
      expect(sentTo(person.email), 'nothing was delivered').toHaveLength(0);

      await vi.waitFor(async () => {
        const events = await linkLogEvents(harness, SUPPRESSED);
        const mine = events.filter(
          (record) => record.attributes['tayzu.identity.user.id'] === person.userId,
        );
        expect(mine.length).toBeGreaterThanOrEqual(1);
        expect(mine[0]?.attributes['tayzu.identity.email.template']).toBe('password_changed');
      });
      await harness.forceFlush();
      const everyLog = JSON.stringify(
        harness.logExporter.getFinishedLogRecords().map((r) => [r.eventName, r.attributes, r.body]),
      );
      expect(everyLog, 'the suppression carries no address').not.toContain(person.email);
    }, 60_000);
  });
});
