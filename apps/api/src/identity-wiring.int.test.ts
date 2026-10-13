/**
 * Task 14.11 of openspec/changes/043-identity-lifecycle-and-org-admin (Resolved
 * decision Q138; design D5 "Sender selection", Q80).
 *
 * Task 14.11 Verify: "`identity-wiring.int.test.ts` (in `apps/api/src/`; every case is
 * built through `createAppFromEnv` with `MOUNT_IDENTITY_ROUTES=true` and observes the
 * sends of the recording sender that `createEmailSender` selects under `NODE_ENV=test`)
 * covers an admin's invite and resend over HTTP each answering 200 and sending one
 * `InvitationEmail` whose link origin is `INVITATION_LINK_BASE_URL`."
 *
 * ## Harness
 *
 * The production bootstrap over the harness pools (as in `step-up.http.int.test.ts`),
 * with `MOUNT_IDENTITY_ROUTES=true`, no `EMAIL_PROVIDER` (so `createEmailSender`
 * selects the recording fake under `NODE_ENV=test`) and an `INVITATION_LINK_BASE_URL`
 * whose origin differs from the API's and from the admin's request origin, so the
 * assertion cannot pass by accident. `./email-sender.js` is wrapped, not replaced: the
 * real `createEmailSender` runs and the sender it returns is captured, which is how the
 * test observes the sends of the sender the production start built. Requests are
 * Fastify injections with a fresh random `x-forwarded-for`; the admin has a fresh MFA
 * verification, so the high-risk `invite` passes step-up. Each case uses a fresh tenant.
 *
 * ## Production symbols expected
 *
 * - `createAppFromEnv` (`./bootstrap.js`) calls `createEmailSender(config)` from
 *   `./email-sender.js` once and passes the sender, `config.invitationLinkBaseUrl`
 *   (Config field names as in `config.ts`), the disabled tenants, the kill switch, the
 *   recipient key secret and the caps through `createApp`'s email settings (replacing
 *   `identity.emailGate`); with the switch on, `createApp` (`./server.js`) builds the
 *   gate of D5 and hands the gate and the link base URL to `createIdentityRouter`.
 */
import { randomInt, randomUUID } from 'node:crypto';

import type { createRecordingEmailSender } from '@tayzu/auth';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrolledAdminSession } from './__fixtures__/fresh-mfa.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';

const state = vi.hoisted(() => ({
  pools: new Map<string, unknown>(),
  senders: [] as unknown[],
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
      const sender = actual.createEmailSender(config);
      state.senders.push(sender);
      return sender;
    }),
  };
});

import { createAppFromEnv } from './bootstrap.js';
import type { App } from './server.js';

type RecordingSender = ReturnType<typeof createRecordingEmailSender>;

const ORIGIN = 'https://app.tayzu.test';
const LINK_ORIGIN = 'https://accept.tayzu.test';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('identity email wiring through createAppFromEnv (task 14.11)', () => {
  let app: App;
  let pools: HarnessPools;

  beforeAll(async () => {
    pools = await harnessPools();
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    app = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: `${ORIGIN},${LINK_ORIGIN}`,
      INVITATION_LINK_BASE_URL: LINK_ORIGIN,
      IDENTITY_TOKEN_HMAC_SECRET: 'wiring-hmac-test-only-secret-0123456789-abcdef',
      MOUNT_IDENTITY_ROUTES: 'true',
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    state.pools.clear();
  }, 60_000);

  function recordingSender(): RecordingSender {
    expect(
      state.senders,
      'the sender is built once per process, by createEmailSender',
    ).toHaveLength(1);
    return state.senders[0] as RecordingSender;
  }

  async function freshAdmin(): Promise<BootstrappedTenant> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Identity Wiring Admin',
      email: `identity-wiring-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Identity Wiring ${suffix}`,
      organizationSlug: `identity-wiring-${suffix}`,
      ip: randomIp(),
    });
    return await enrolledAdminSession(app, tenant, { password: TEST_PASSWORD, origin: ORIGIN });
  }

  async function post(
    cookie: string,
    url: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: string; json: Record<string, unknown> }> {
    const response = await app.app.inject({
      method: 'POST',
      url,
      headers: {
        cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    let json: Record<string, unknown> = {};
    try {
      json = response.json<Record<string, unknown>>();
    } catch {
      // A non-JSON body leaves the object empty and fails the assertions.
    }
    return { status: response.statusCode, body: response.body, json };
  }

  function sentTo(email: string): readonly { to: string; template: { kind: string } }[] {
    return recordingSender().sent.filter((message) => message.to === email);
  }

  function linkOf(email: string, index: number): URL {
    const template = recordingSender().sent.filter((message) => message.to === email)[index]
      ?.template;
    if (template?.kind !== 'InvitationEmail') throw new Error('no InvitationEmail was sent');
    return new URL(template.link);
  }

  it("an admin's invite over HTTP answers 200 and sends one InvitationEmail whose link origin is INVITATION_LINK_BASE_URL", async () => {
    const admin = await freshAdmin();
    const email = `identity-wiring-invitee-${randomUUID()}@example.test`;

    const answer = await post(admin.cookie, '/v1/users/invitations', { email, role: 'member' });

    expect(answer.status, answer.body).toBe(200);
    expect(typeof answer.json['invitationId']).toBe('string');
    const sent = sentTo(email);
    expect(sent, 'exactly one email to the invitee').toHaveLength(1);
    expect(sent[0]?.template.kind).toBe('InvitationEmail');
    expect(linkOf(email, 0).origin).toBe(LINK_ORIGIN);
  });

  it("an admin's resend over HTTP answers 200 and sends one InvitationEmail whose link origin is INVITATION_LINK_BASE_URL", async () => {
    const admin = await freshAdmin();
    const email = `identity-wiring-resend-${randomUUID()}@example.test`;
    const invited = await post(admin.cookie, '/v1/users/invitations', { email, role: 'member' });
    expect(invited.status, invited.body).toBe(200);
    const invitationId = invited.json['invitationId'];
    expect(typeof invitationId).toBe('string');
    const before = sentTo(email).length;

    const answer = await post(admin.cookie, `/v1/users/invitations/${String(invitationId)}/resend`);

    expect(answer.status, answer.body).toBe(200);
    const after = sentTo(email);
    expect(after.length - before, 'the resend sends exactly one more email').toBe(1);
    expect(after.at(-1)?.template.kind).toBe('InvitationEmail');
    expect(linkOf(email, after.length - 1).origin).toBe(LINK_ORIGIN);
  });
});
