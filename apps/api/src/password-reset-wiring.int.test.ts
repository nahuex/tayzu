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
  omitSender: false,
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
      // Task 13.3: a deployment whose email sender is not configured.
      if (state.omitSender)
        return undefined as unknown as ReturnType<typeof actual.createEmailSender>;
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

/**
 * Task 13.2 of openspec/changes/044-password-reset-and-account-recovery (design D5 "The email path
 * of an anonymous reset", D9 "Configuration").
 *
 * Spec clauses behind the cases (`specs/password-reset-and-account-recovery/spec.md`):
 * - "A suppressed request leaves the earlier link valid": GIVEN an eligible user who holds a valid
 *   link, and then a full recipient cap, a kill switch turned on, every tenant of the user on the
 *   disabled-tenant list, or a recipient domain that is not on the allowlist; WHEN the address is
 *   posted again; THEN the answer is the uniform one and the earlier link still works.
 * - "A per-recipient cap is silent", "A demo login cannot send mail", "The kill switch and the
 *   allowlist apply": nothing is sent and the answer is the uniform one.
 * - Requirement "Reset traffic is limited before any lookup" and "The reset email is sent through
 *   controls that never become an oracle": the defaults are 10 per 60 s per IP on each route,
 *   5 per hour per recipient, 10 per hour per IP and 600 per hour globally; 400 ms minimum response.
 *
 * Harness: as 13.1 (`createAppFromEnv`, the recording sender). The "earlier link" is issued by an
 * app with open controls, and the control under test is an app over the same database built with
 * the control on, so the earlier link is requested before the control applies. A send is observed on
 * `state.sendsStarted` (it counts calls to the sender, also when the sender wraps an allowlist).
 * The global cap is a bucket with one constant key shared by every test file, so its case uses a
 * window length drawn at random per run (a private fixed-window bucket) and the defaults case keeps
 * a roomy global cap: the 600-per-hour default cannot be exhausted on the shared database, and the
 * 10-per-hour IP default cannot be told apart from the 10-per-minute route limit.
 *
 * ## Production symbols expected
 *
 * - `createAppFromEnv` (`./bootstrap.js`) passes `config.emailRecipientDomainAllowlist` as
 *   `email.recipientDomainAllowlist` to `createApp` (today it does not, so the reset mailer applies
 *   no allowlist at admission and a blocked recipient still gets a new token).
 */
describe('password reset controls through createAppFromEnv (task 13.2)', () => {
  let pools: HarnessPools;
  const apps: App[] = [];

  async function build(
    extra: Record<string, string | undefined> = {},
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
    for (const built of apps) await built.close().catch(() => undefined);
    state.pools.clear();
  }, 60_000);

  async function createAccount(
    app: App,
  ): Promise<{ email: string; userId: string; tenantId: string }> {
    const suffix = randomUUID();
    const email = `reset-controls-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Reset Controls User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Reset Controls Org ${suffix}`,
      organizationSlug: `reset-controls-${suffix}`,
      ip: randomIp(),
    });
    return { email, userId: tenant.userId, tenantId: tenant.organizationId };
  }

  async function post(app: App, email: string, ip: string = randomIp()) {
    return await app.app.inject({
      method: 'POST',
      url: REQUEST_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': ip,
      },
      payload: JSON.stringify({ email }),
    });
  }

  async function confirm(app: App, id: string | null, token: string | null, ip = randomIp()) {
    return await app.app.inject({
      method: 'POST',
      url: CONFIRM_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': ip,
      },
      payload: JSON.stringify({ id, token, newPassword: NEW_PASSWORD }),
    });
  }

  function resetMailsTo(sender: RecordingSender, address: string) {
    return sender.sent.filter(
      (message) => message.to === address && message.template.kind === 'PasswordResetEmail',
    );
  }

  /** Requests a reset and returns the id and token of the emailed link. */
  async function requestLink(
    app: App,
    sender: RecordingSender,
    email: string,
    ip?: string,
  ): Promise<{ id: string | null; token: string | null }> {
    const answer = await post(app, email, ip);
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json()).toEqual({ accepted: true });
    await vi.waitFor(() => {
      expect(resetMailsTo(sender, email).length).toBeGreaterThanOrEqual(1);
    });
    const template = resetMailsTo(sender, email).at(-1)?.template;
    if (template?.kind !== 'PasswordResetEmail') throw new Error('no PasswordResetEmail was sent');
    const fragment = new URLSearchParams(new URL(template.link).hash.slice(1));
    return { id: fragment.get('reset'), token: fragment.get('token') };
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  async function expectLinkStillWorks(
    app: App,
    link: { id: string | null; token: string | null },
  ): Promise<void> {
    const confirmed = await confirm(app, link.id, link.token);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toEqual({ completed: true });
  }

  describe('the recipient, IP and global caps, the kill switch, the disabled-tenant list and the recipient-domain allowlist suppress silently with the uniform answer and leave the earlier link valid', () => {
    it('the recipient cap', async () => {
      const { app, sender } = await build({
        PASSWORD_RESET_RECIPIENT_RATE_LIMIT_MAX: '1',
        PASSWORD_RESET_RECIPIENT_RATE_LIMIT_WINDOW_SECONDS: '3600',
      });
      const account = await createAccount(app);
      const link = await requestLink(app, sender, account.email);
      const sent = state.sendsStarted;

      const again = await post(app, account.email);

      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toEqual({ accepted: true });
      await settle();
      expect(state.sendsStarted, 'nothing reached the sender').toBe(sent);
      expect(resetMailsTo(sender, account.email)).toHaveLength(1);
      await expectLinkStillWorks(app, link);
    }, 120_000);

    it('the IP cap', async () => {
      const { app, sender } = await build({
        PASSWORD_RESET_IP_RATE_LIMIT_MAX: '1',
        PASSWORD_RESET_IP_RATE_LIMIT_WINDOW_SECONDS: '3600',
      });
      const account = await createAccount(app);
      const ip = randomIp();
      const link = await requestLink(app, sender, account.email, ip);
      const sent = state.sendsStarted;

      const again = await post(app, account.email, ip);

      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toEqual({ accepted: true });
      await settle();
      expect(state.sendsStarted, 'nothing reached the sender').toBe(sent);
      expect(resetMailsTo(sender, account.email)).toHaveLength(1);
      await expectLinkStillWorks(app, link);
    }, 120_000);

    it('the global cap', async () => {
      // A private fixed-window bucket: the window length is random per run.
      const { app, sender } = await build({
        PASSWORD_RESET_GLOBAL_RATE_LIMIT_MAX: '1',
        PASSWORD_RESET_GLOBAL_RATE_LIMIT_WINDOW_SECONDS: String(200_000 + randomInt(1_000_000)),
      });
      const account = await createAccount(app);
      const link = await requestLink(app, sender, account.email);
      const sent = state.sendsStarted;

      const again = await post(app, account.email);

      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toEqual({ accepted: true });
      await settle();
      expect(state.sendsStarted, 'nothing reached the sender').toBe(sent);
      expect(resetMailsTo(sender, account.email)).toHaveLength(1);
      await expectLinkStillWorks(app, link);
    }, 120_000);

    it('the kill switch', async () => {
      const open = await build();
      const account = await createAccount(open.app);
      const link = await requestLink(open.app, open.sender, account.email);
      const { app: switched, sender } = await build({ INVITATION_EMAIL_KILL_SWITCH: 'true' });
      const sent = state.sendsStarted;

      const again = await post(switched, account.email);

      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toEqual({ accepted: true });
      await settle();
      expect(state.sendsStarted, 'nothing reached the sender').toBe(sent);
      expect(resetMailsTo(sender, account.email)).toHaveLength(0);
      await expectLinkStillWorks(open.app, link);
    }, 120_000);

    it('the disabled-tenant list', async () => {
      const open = await build();
      const account = await createAccount(open.app);
      const link = await requestLink(open.app, open.sender, account.email);
      const { app: disabled, sender } = await build({
        EMAIL_DISABLED_TENANT_IDS: account.tenantId,
      });
      const sent = state.sendsStarted;

      const again = await post(disabled, account.email);

      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toEqual({ accepted: true });
      await settle();
      expect(state.sendsStarted, 'nothing reached the sender').toBe(sent);
      expect(resetMailsTo(sender, account.email)).toHaveLength(0);
      await expectLinkStillWorks(open.app, link);
    }, 120_000);

    it('the recipient-domain allowlist', async () => {
      const open = await build();
      const account = await createAccount(open.app);
      const link = await requestLink(open.app, open.sender, account.email);
      const { app: restricted } = await build({
        EMAIL_RECIPIENT_DOMAIN_ALLOWLIST: 'allowed.example',
      });
      const sent = state.sendsStarted;

      const again = await post(restricted, account.email);

      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toEqual({ accepted: true });
      await settle();
      expect(state.sendsStarted, 'nothing reached the sender').toBe(sent);
      await expectLinkStillWorks(open.app, link);
    }, 120_000);
  });

  it('two app instances share the caps', async () => {
    const caps = {
      PASSWORD_RESET_RECIPIENT_RATE_LIMIT_MAX: '1',
      PASSWORD_RESET_RECIPIENT_RATE_LIMIT_WINDOW_SECONDS: '3600',
      PASSWORD_RESET_IP_RATE_LIMIT_MAX: '1',
      PASSWORD_RESET_IP_RATE_LIMIT_WINDOW_SECONDS: '3600',
    };
    const first = await build(caps);
    const second = await build(caps);
    const one = await createAccount(first.app);
    const two = await createAccount(first.app);
    const ip = randomIp();
    await requestLink(first.app, first.sender, one.email, ip);
    const sent = state.sendsStarted;

    // The IP bucket was filled through the first instance.
    const sameIp = await post(second.app, two.email, ip);
    // The recipient bucket was filled through the first instance.
    const sameRecipient = await post(second.app, one.email);

    expect(sameIp.statusCode, sameIp.body).toBe(200);
    expect(sameIp.json()).toEqual({ accepted: true });
    expect(sameRecipient.statusCode, sameRecipient.body).toBe(200);
    expect(sameRecipient.json()).toEqual({ accepted: true });
    await settle();
    expect(state.sendsStarted, 'the second instance sent nothing').toBe(sent);
    expect(resetMailsTo(second.sender, two.email)).toHaveLength(0);
    expect(resetMailsTo(second.sender, one.email)).toHaveLength(0);
  }, 120_000);

  it('the configured defaults are applied when no override is set', async () => {
    // Only the global cap (a bucket shared by every test file) stays roomy; every other limit and
    // the minimum response time are unset, so the defaults apply.
    const { app, sender } = await build({
      PASSWORD_RESET_MIN_RESPONSE_MS: undefined,
    });
    const account = await createAccount(app);

    // 400 ms minimum response time.
    const started = performance.now();
    const first = await post(app, account.email);
    expect(first.statusCode, first.body).toBe(200);
    expect(performance.now() - started, 'the default minimum response time').toBeGreaterThanOrEqual(
      380,
    );

    // 5 emails per hour per recipient: the sixth is suppressed.
    for (let n = 2; n <= 6; n += 1) {
      const answer = await post(app, account.email);
      expect(answer.statusCode, answer.body).toBe(200);
      expect(answer.json()).toEqual({ accepted: true });
    }
    await settle();
    await vi.waitFor(() => {
      expect(resetMailsTo(sender, account.email)).toHaveLength(5);
    });

    // 10 requests per 60 seconds per IP on the request route: the eleventh is limited.
    const ip = randomIp();
    for (let n = 1; n <= 10; n += 1) {
      const answer = await post(app, `nobody-${randomUUID()}@example.test`, ip);
      expect(answer.statusCode, `request ${String(n)}`).toBe(200);
    }
    const limited = await post(app, `nobody-${randomUUID()}@example.test`, ip);
    expect(limited.statusCode, limited.body).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();

    // 10 requests per 60 seconds per IP on the confirm route: the eleventh is limited.
    const confirmIp = randomIp();
    for (let n = 1; n <= 10; n += 1) {
      const answer = await confirm(app, randomUUID(), randomUUID(), confirmIp);
      expect(answer.statusCode, `confirm ${String(n)}`).not.toBe(429);
    }
    const confirmLimited = await confirm(app, randomUUID(), randomUUID(), confirmIp);
    expect(confirmLimited.statusCode, confirmLimited.body).toBe(429);
  }, 180_000);
});

/**
 * Task 13.3 of openspec/changes/044-password-reset-and-account-recovery (design D9 "Startup
 * failure rules").
 *
 * Spec scenario "Mounting without the email path fails startup" (`specs/password-reset-and-account-recovery/spec.md`):
 * WHEN the switch is on and the reset link base URL, the recipient key secret or the email sender
 * is not configured; THEN startup fails naming the variable and never its value.
 *
 * Harness: as 13.1, with `MOUNT_IDENTITY_ROUTES=true`. Each case leaves out one of the three; the
 * other values carry distinctive markers, and the error must not contain any of them. A missing
 * sender is simulated by the `./email-sender.js` wrapper returning nothing (`state.omitSender`).
 *
 * ## Production symbols expected
 *
 * - `createApp` (`./server.js`) throws, with `mountIdentityRoutes` on, an error naming
 *   `PASSWORD_RESET_LINK_BASE_URL` when `email.passwordResetLinkBaseUrl` is missing, and an error
 *   naming `EMAIL_PROVIDER` when `email.sender` is missing. The existing `IDENTITY_TOKEN_HMAC_SECRET`
 *   rule is kept. `createAppFromEnv` lets these errors through unchanged.
 */
describe('mounting without the email path fails startup through createAppFromEnv (task 13.3)', () => {
  let pools: HarnessPools;
  const HMAC_MARKER = 'marker-hmac-secret-0123456789-abcdefghijklmnop-zz';
  const BASE_URL_MARKER = 'https://marker-reset-origin.tayzu.test';

  beforeAll(async () => {
    pools = await harnessPools();
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
  }, 60_000);

  afterEach(() => {
    state.omitSender = false;
  });

  afterAll(() => {
    state.pools.clear();
  });

  function env(drop: string | undefined): Record<string, string> {
    const full: Record<string, string> = {
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: `${ORIGIN},${BASE_URL_MARKER}`,
      INVITATION_LINK_BASE_URL: ORIGIN,
      PASSWORD_RESET_LINK_BASE_URL: BASE_URL_MARKER,
      IDENTITY_TOKEN_HMAC_SECRET: HMAC_MARKER,
      MOUNT_IDENTITY_ROUTES: 'true',
    };
    if (drop !== undefined) Reflect.deleteProperty(full, drop);
    return full;
  }

  async function startupError(drop: string | undefined): Promise<string> {
    let built: App | undefined;
    try {
      built = await createAppFromEnv(env(drop));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    await built.close().catch(() => undefined);
    return '';
  }

  function expectNoValues(message: string): void {
    for (const value of [HMAC_MARKER, BASE_URL_MARKER, TEST_SECRET]) {
      expect(message, 'the error never carries a configured value').not.toContain(value);
    }
  }

  it('Mounting without the email path fails startup: the reset link base URL', async () => {
    const message = await startupError('PASSWORD_RESET_LINK_BASE_URL');

    expect(message).toContain('PASSWORD_RESET_LINK_BASE_URL');
    expectNoValues(message);
  }, 60_000);

  it('Mounting without the email path fails startup: the recipient key secret', async () => {
    const message = await startupError('IDENTITY_TOKEN_HMAC_SECRET');

    expect(message).toContain('IDENTITY_TOKEN_HMAC_SECRET');
    expectNoValues(message);
  }, 60_000);

  it('Mounting without the email path fails startup: the sender', async () => {
    state.omitSender = true;

    const message = await startupError(undefined);

    expect(message).toContain('EMAIL_PROVIDER');
    expectNoValues(message);
  }, 60_000);
});
