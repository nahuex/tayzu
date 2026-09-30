/**
 * Integration test for task 23.21 (openspec/changes/002-auth-and-rbac; design
 * Resolved decision Q48 and D23).
 *
 * Task 23.21: "A failed Visma Connect discovery at startup fails startup
 * instead of silently skipping the provider. Verify: `sso-startup.int.test.ts`
 * covers an unreachable and a malformed discovery document each making
 * `createApp`/`main` fail with a sanitized error and no listener bound, and a
 * reachable stub starting normally."
 *
 * This is a hardening task with no new spec scenario: it pins the D23 rule
 * that SSO is configured, so a configured provider that cannot be discovered
 * must stop the process rather than leave a server that silently has no SSO.
 *
 * ## Harness
 *
 * The app is built by the production bootstrap, `createAppFromEnv(env)`, and
 * the process entry point is `start(env)` from `./main.js` (`PORT` is a free
 * port chosen by the test, so "no listener bound" is checked by a refused TCP
 * connection). Discovery is pointed at: a closed local port (unreachable), a
 * local HTTP server answering 200 with a body that is not JSON, one answering
 * a JSON document without the fields discovery needs (`issuer`, `jwks_uri`),
 * and the task-19.1 OIDC stub (reachable). `@tayzu/db`'s `createPool` is
 * mocked to the real harness pools, as in the other `createAppFromEnv` tests.
 *
 * "Sanitized": the error message does not contain the discovery URL, its host
 * or port, the client id/secret, or any part of the discovery response body.
 *
 * ## Production symbols expected (the red phase)
 *
 * No new exported symbol. `createApp` (`./server.js`) must, when `sso` is
 * configured, resolve the provider's discovery document before it returns and
 * reject with a sanitized error when discovery fails (network error, non-JSON,
 * or a document missing the required fields). `createAppFromEnv` and `start`
 * propagate that rejection; `start` never reaches `listen`. Today the
 * provider is skipped silently and the app starts without SSO.
 */
import { createServer, type Server } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';

const state = vi.hoisted(() => ({ pools: new Map<string, unknown>() }));

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

import { createAppFromEnv } from './bootstrap.js';
import { start } from './main.js';

const ORIGIN = 'https://app.tayzu.test';
const CLIENT_ID = 'startup-client-id';
const CLIENT_SECRET = 'startup-client-secret-value';
const MARKER = 'discovery-body-marker-7f3a';

function baseEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://tayzu_app:pw@db.invalid:5432/tayzu?sslmode=verify-full',
    AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@db.invalid:5432/tayzu?sslmode=verify-full',
    BETTER_AUTH_SECRET: TEST_SECRET,
    CERBOS_ADDRESS: 'localhost:3593',
    ALLOWED_ORIGINS: ORIGIN,
  };
}

function ssoEnv(discoveryUrl: string): Record<string, string> {
  return {
    ...baseEnv(),
    VISMA_CONNECT_DISCOVERY_URL: discoveryUrl,
    VISMA_CONNECT_CLIENT_ID: CLIENT_ID,
    VISMA_CONNECT_CLIENT_SECRET: CLIENT_SECRET,
  };
}

/** A port nothing listens on: bind to 0, read the port, release it. */
async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function isRefused(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(true);
    });
  });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('expected startup to fail, but it succeeded');
}

function expectSanitized(error: Error, discoveryUrl: string): void {
  const url = new URL(discoveryUrl);
  const text = `${error.message}\n${error.stack ?? ''}`;
  expect(text).not.toContain(discoveryUrl);
  expect(text).not.toContain(url.host);
  expect(text).not.toContain(CLIENT_ID);
  expect(text).not.toContain(CLIENT_SECRET);
  expect(text).not.toContain(MARKER);
  expect(error.message.length).toBeGreaterThan(0);
}

describe('A failed Visma Connect discovery fails startup (task 23.21, design Q48 and D23)', () => {
  let stub: OidcStub;
  const servers: Server[] = [];

  async function discoveryServer(body: string, contentType: string): Promise<string> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': contentType });
      res.end(body);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}/.well-known/openid-configuration`;
  }

  beforeAll(async () => {
    const pools = await harnessPools();
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    stub = await startOidcStub({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await stub.close();
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    state.pools.clear();
  }, 60_000);

  it('createApp fails with a sanitized error when the discovery endpoint is unreachable', async () => {
    const port = await freePort();
    const discoveryUrl = `http://127.0.0.1:${String(port)}/.well-known/openid-configuration`;
    const error = await rejection(createAppFromEnv(ssoEnv(discoveryUrl)));
    expectSanitized(error, discoveryUrl);
  }, 30_000);

  it('createApp fails with a sanitized error when the discovery document is not JSON', async () => {
    const discoveryUrl = await discoveryServer(`<html>${MARKER}</html>`, 'text/html');
    const error = await rejection(createAppFromEnv(ssoEnv(discoveryUrl)));
    expectSanitized(error, discoveryUrl);
  }, 30_000);

  it('createApp fails with a sanitized error when the discovery document lacks the required fields', async () => {
    const discoveryUrl = await discoveryServer(
      JSON.stringify({ note: MARKER, authorization_endpoint: 'https://example.test/authorize' }),
      'application/json',
    );
    const error = await rejection(createAppFromEnv(ssoEnv(discoveryUrl)));
    expectSanitized(error, discoveryUrl);
  }, 30_000);

  it('main fails with a sanitized error and binds no listener when discovery is unreachable', async () => {
    const discoveryPort = await freePort();
    const discoveryUrl = `http://127.0.0.1:${String(discoveryPort)}/.well-known/openid-configuration`;
    const port = await freePort();
    const error = await rejection(
      start({ ...ssoEnv(discoveryUrl), HOST: '127.0.0.1', PORT: String(port) }),
    );
    expectSanitized(error, discoveryUrl);
    expect(await isRefused(port), 'no listener is bound on the configured port').toBe(true);
  }, 30_000);

  it('main fails with a sanitized error and binds no listener when the discovery document is malformed', async () => {
    const discoveryUrl = await discoveryServer(`not json ${MARKER}`, 'application/json');
    const port = await freePort();
    const error = await rejection(
      start({ ...ssoEnv(discoveryUrl), HOST: '127.0.0.1', PORT: String(port) }),
    );
    expectSanitized(error, discoveryUrl);
    expect(await isRefused(port), 'no listener is bound on the configured port').toBe(true);
  }, 30_000);

  it('a reachable discovery stub starts normally', async () => {
    const port = await freePort();
    const running = await start({
      ...ssoEnv(stub.discoveryUrl),
      HOST: '127.0.0.1',
      PORT: String(port),
    });
    try {
      expect(running.port).toBe(port);
      expect(await isRefused(port), 'the listener is bound').toBe(false);
    } finally {
      await running.close();
    }
  }, 30_000);
});
