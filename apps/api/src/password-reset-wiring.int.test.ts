/**
 * Task 13.1 of openspec/changes/044-password-reset-and-account-recovery (design D9 "Configuration",
 * D2 "The routes", D4 "Detached send": "the mailer tracks in-flight sends and `app.close` drains
 * them").
 *
 * Task 13.1 Verify: `apps/api/src/password-reset-wiring.int.test.ts` (every case built with
 * `createAppFromEnv`, `MOUNT_IDENTITY_ROUTES=true` and the recording sender `createEmailSender`
 * selects), cases "a request sends one `PasswordResetEmail` whose link starts with
 * `PASSWORD_RESET_LINK_BASE_URL`", "the emailed id and token complete a reset", and "closing the
 * app drains an in-flight send".
 *
 * Spec clauses behind the cases (`specs/password-reset-and-account-recovery/spec.md`):
 * - "The link carries the token in the fragment on the configured origin": the link starts with the
 *   configured `PASSWORD_RESET_LINK_BASE_URL`, and the id and token are in the fragment
 *   (`#reset=<id>&token=<token>`) and nowhere else.
 * - "The new password signs in": a sign-in with the new password succeeds and one with the old
 *   password fails.
 * - Design D4: a graceful shutdown (`app.close`) does not drop mail that was admitted and detached.
 *
 * ## Harness
 *
 * The production bootstrap over the harness pools (as `identity-wiring.int.test.ts`), with
 * `MOUNT_IDENTITY_ROUTES=true`, no `EMAIL_PROVIDER` (so `createEmailSender` selects the recording
 * fake under `NODE_ENV=test`), `PASSWORD_RESET_LINK_BASE_URL` on an origin that differs from the
 * API's and from the request origin, and roomy caps (the shared test database keeps the global
 * bucket between files): `PASSWORD_RESET_GLOBAL_RATE_LIMIT_MAX=100000`. `./email-sender.js` is
 * wrapped, not replaced: the real `createEmailSender` runs, and what the app receives is a proxy of
 * it whose `send` waits `state.sendDelayMs` first (zero except in the drain case), so the test can
 * hold a send in flight. The proxy records on the real recording sender, which the test reads.
 * Requests are Fastify injections with a fresh random `x-forwarded-for`. Accounts are bootstrapped
 * tenants with random emails. The breached-password range service is a stubbed global `fetch`
 * that reports nothing as breached.
 *
 * ## Production symbols expected
 *
 * - `createAppFromEnv` (`./bootstrap.js`) passes `config.passwordResetLinkBaseUrl` as
 *   `email.passwordResetLinkBaseUrl` to `createApp` (today it passes only the invitation base URL,
 *   so the request route has no origin for the link).
 * - `createApp`'s `close()` awaits the recovery mailer's in-flight sends (`drain`) before it
 *   returns, and `createAppFromEnv`'s `close()` keeps calling it.
 */
import { randomInt, randomUUID } from 'node:crypto';

import type { createRecordingEmailSender } from '@tayzu/auth';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  signInAdminUser,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';

const state = vi.hoisted(() => ({
  pools: new Map<string, unknown>(),
  senders: [] as unknown[],
  sendDelayMs: 0,
  sendsStarted: 0,
}));

vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return {
    ...actual,
    createPool: vi.fn((url: string) => {
      const role = url.includes('tayzu_auth') ? 'auth' : 'app';
      const real = state.pools.get(role) as object;
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'end') {
            return () => Promise.resolve();
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }),
  };
});

vi.mock('./email-sender.js', async (importActual) => {
  const actual = await importActual<typeof import('./email-sender.js')>();
  return {
    ...actual,
    createEmailSender: vi.fn((config: Parameters<typeof actual.createEmailSender>[0]) => {
      const real = actual.createEmailSender(config);
      state.senders.push(real);
      const send = async (...args: unknown[]): Promise<unknown> => {
        state.sendsStarted += 1;
        if (state.sendDelayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, state.sendDelayMs));
        }
        return await (real as unknown as { send: (...a: unknown[]) => Promise<unknown> }).send(
          ...args,
        );
      };
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'send') return send;
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }),
  };
});

import { createAppFromEnv } from './bootstrap.js';
import type { App } from './server.js';

type RecordingSender = ReturnType<typeof createRecordingEmailSender>;

const ORIGIN = 'https://app.tayzu.test';
const RESET_LINK_ORIGIN = 'https://recover.tayzu.test';
const REQUEST_PATH = '/v1/auth/password-reset/request';
const CONFIRM_PATH = '/v1/auth/password-reset/confirm';
const NEW_PASSWORD = 'Another-Perfectly-Fine-Passphrase-77!';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('password reset wiring through createAppFromEnv (task 13.1)', () => {
  let pools: HarnessPools;
  const apps: App[] = [];

  async function buildApp(
    extra: Record<string, string> = {},
  ): Promise<{ app: App; sender: RecordingSender }> {
    const before = state.senders.length;
    const built = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: `${ORIGIN},${RESET_LINK_ORIGIN}`,
      INVITATION_LINK_BASE_URL: ORIGIN,
      PASSWORD_RESET_LINK_BASE_URL: RESET_LINK_ORIGIN,
      IDENTITY_TOKEN_HMAC_SECRET: 'reset-wiring-hmac-test-only-secret-0123456789-abcdef',
      MOUNT_IDENTITY_ROUTES: 'true',
      PASSWORD_RESET_MIN_RESPONSE_MS: '1',
      PASSWORD_RESET_GLOBAL_RATE_LIMIT_MAX: '100000',
      PASSWORD_RESET_GLOBAL_RATE_LIMIT_WINDOW_SECONDS: '3600',
      ...extra,
    });
    apps.push(built);
    expect(state.senders.length, 'one sender is built for this app').toBe(before + 1);
    return { app: built, sender: state.senders[before] as RecordingSender };
  }

  beforeAll(async () => {
    pools = await harnessPools();
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
  }, 60_000);

  beforeEach(() => {
    state.sendDelayMs = 0;
    state.sendsStarted = 0;
    // The range service reports nothing as breached.
    vi.stubGlobal('fetch', (): Promise<Response> => {
      return Promise.resolve(
        new Response('0000000000000000000000000000000000A:3\r\n', { status: 200 }),
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    state.sendDelayMs = 0;
  });

  afterAll(async () => {
    // An app closed by its own case is closed again here; close must tolerate it.
    for (const built of apps) await built.close().catch(() => undefined);
    state.pools.clear();
  }, 60_000);

  async function createAccount(app: App): Promise<{ email: string; userId: string }> {
    const suffix = randomUUID();
    const email = `reset-wiring-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Reset Wiring User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Reset Wiring Org ${suffix}`,
      organizationSlug: `reset-wiring-${suffix}`,
      ip: randomIp(),
    });
    return { email, userId: tenant.userId };
  }

  async function requestReset(app: App, email: string, forged = false) {
    return await app.app.inject({
      method: 'POST',
      url: REQUEST_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
        ...(forged ? { 'x-forwarded-host': 'evil.example', host: 'evil.example' } : {}),
      },
      payload: JSON.stringify({ email }),
    });
  }

  function resetEmailsTo(sender: RecordingSender, address: string) {
    return sender.sent.filter(
      (message) => message.to === address && message.template.kind === 'PasswordResetEmail',
    );
  }

  function linkTo(sender: RecordingSender, address: string): URL {
    const template = resetEmailsTo(sender, address)[0]?.template;
    if (template?.kind !== 'PasswordResetEmail') throw new Error('no PasswordResetEmail was sent');
    return new URL(template.link);
  }

  it('a request sends one PasswordResetEmail whose link starts with PASSWORD_RESET_LINK_BASE_URL', async () => {
    const { app, sender } = await buildApp();
    const account = await createAccount(app);

    const answer = await requestReset(app, account.email, true);

    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json()).toEqual({ accepted: true });
    await vi.waitFor(() => {
      expect(resetEmailsTo(sender, account.email)).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(resetEmailsTo(sender, account.email), 'exactly one email').toHaveLength(1);
    const message = resetEmailsTo(sender, account.email)[0]?.template;
    if (message?.kind !== 'PasswordResetEmail') throw new Error('no PasswordResetEmail was sent');
    expect(message.link.startsWith(RESET_LINK_ORIGIN)).toBe(true);
    const link = linkTo(sender, account.email);
    expect(link.origin).toBe(RESET_LINK_ORIGIN);
    expect(link.search, 'nothing outside the fragment').toBe('');
    const fragment = new URLSearchParams(link.hash.slice(1));
    expect(fragment.get('reset') ?? '').not.toBe('');
    expect(fragment.get('token') ?? '').not.toBe('');
  }, 120_000);

  it('the emailed id and token complete a reset', async () => {
    const { app, sender } = await buildApp();
    const account = await createAccount(app);
    expect((await requestReset(app, account.email)).statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(resetEmailsTo(sender, account.email)).toHaveLength(1);
    });
    const fragment = new URLSearchParams(linkTo(sender, account.email).hash.slice(1));

    const confirmed = await app.app.inject({
      method: 'POST',
      url: CONFIRM_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify({
        id: fragment.get('reset'),
        token: fragment.get('token'),
        newPassword: NEW_PASSWORD,
      }),
    });

    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toEqual({ completed: true });
    const signedIn = await signInAdminUser(app.auth, {
      email: account.email,
      password: NEW_PASSWORD,
      ip: randomIp(),
    });
    expect(signedIn.userId).toBe(account.userId);
    await expect(
      signInAdminUser(app.auth, {
        email: account.email,
        password: TEST_PASSWORD,
        ip: randomIp(),
      }),
    ).rejects.toThrow();
  }, 120_000);

  it('closing the app drains an in-flight send', async () => {
    const { app, sender } = await buildApp();
    const account = await createAccount(app);
    state.sendDelayMs = 1500;

    const answer = await requestReset(app, account.email);

    expect(answer.statusCode, answer.body).toBe(200);
    await vi.waitFor(() => {
      expect(state.sendsStarted, 'the detached send has started').toBeGreaterThanOrEqual(1);
    });
    expect(resetEmailsTo(sender, account.email), 'the send is still in flight').toHaveLength(0);

    await app.close();

    expect(resetEmailsTo(sender, account.email), 'close waited for the send').toHaveLength(1);
  }, 120_000);
});
