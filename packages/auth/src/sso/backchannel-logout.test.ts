/**
 * Task 7.6 of change `048-production-hardening` (design D8 "Cache", Resolved decision Q25;
 * `specs/auth-and-rbac/spec.md` of 048, requirement "Back-channel logout": "The provider's
 * discovery document and signing keys MUST be cached for a bounded time; when they are
 * neither cached nor retrievable, the token MUST be rejected, never accepted.").
 *
 * Scenario covered verbatim:
 *
 * - "Unavailable signing keys fail closed": GIVEN no cached discovery document or key set,
 *   and a provider that cannot be reached, WHEN a logout token is received, THEN it is
 *   rejected and no session is revoked.
 *
 * Plus the D8 cache bounds the task's Verify clause names: one fetch for several tokens
 * within the TTL, a refetch after it, at most one unknown-`kid` refresh per 60 seconds, and
 * an expired copy never used.
 *
 * ## Assumed production API
 *
 * ```ts
 * // ./backchannel-logout.ts
 * export interface LogoutKeyCache { ... }            // opaque to callers
 * export function createLogoutKeyCache(options: { readonly ttlSeconds: number }): LogoutKeyCache;
 * export function verifyLogoutToken(
 *   logoutToken: string,
 *   expected: LogoutTokenExpectation,
 *   keyCache: LogoutKeyCache,                          // new third argument (D8)
 * ): Promise<VerifiedLogoutToken | null>;
 * ```
 *
 * D8 names `createLogoutKeyCache({ ttlSeconds: 600 })` but not how the verifier consumes it;
 * the minimal integration consistent with today's signature is a third argument, so one
 * cache lives per app (created next to `handleLogoutToken`) and each test here gets its own.
 * A rejected token resolves `null` (the `invalid` outcome), as it does today.
 *
 * The cache's clock is `Date.now()` (faked with `vi.useFakeTimers({ toFake: ['Date'] })`,
 * so `AbortSignal.timeout` keeps real timers) and its only outbound path is
 * `globalThis.fetch` (stubbed with `vi.stubGlobal`), as the verifier's are today. Every
 * token is minted at the current fake time with a 120-second lifetime, inside the 300-second
 * bound of task 7.7.
 *
 * Pure unit test: no database, no network.
 */
import { createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLogoutKeyCache,
  verifyLogoutToken,
  type LogoutTokenExpectation,
} from './backchannel-logout.js';

const ISSUER = 'https://connect.example.test';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const JWKS_URL = `${ISSUER}/jwks`;
const CLIENT_ID = 'tayzu-client';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const TTL_SECONDS = 600;
const START_MS = Date.UTC(2026, 10, 28, 12, 0, 0);

const expected: LogoutTokenExpectation = {
  issuer: ISSUER,
  discoveryUrl: DISCOVERY_URL,
  clientId: CLIENT_ID,
};

interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: JsonWebKey;
}

function makeKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
  };
}

// Generated once: RSA key generation is the slow part of this file.
const keyA = makeKey('key-a');
const keyB = makeKey('key-b');
const keyC = makeKey('key-c');

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

let tokenCounter = 0;

/** A logout token that passes every cheap claim check at the current (fake) time. */
function mintLogoutToken(key: SigningKey, overrides: Record<string, unknown> = {}): string {
  tokenCounter += 1;
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'RS256', typ: 'logout+jwt', kid: key.kid });
  const body = encode({
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: now,
    exp: now + 120,
    jti: `jti-${String(tokenCounter)}`,
    sid: `sid-${String(tokenCounter)}`,
    events: { [LOGOUT_EVENT]: {} },
    ...overrides,
  });
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${body}`)
    .sign(key.privateKey)
    .toString('base64url');
  return `${header}.${body}.${signature}`;
}

type Availability = 'up' | 'http-error' | 'network-error';

/** The provider behind `globalThis.fetch`: discovery and JWKS, each switchable down. */
interface ProviderStub {
  discovery: Availability;
  jwks: Availability;
  keys: readonly SigningKey[];
  readonly calls: { discovery: number; jwks: number; other: number };
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (input instanceof Request) {
    return input.url;
  }
  return String(input);
}

function answer(availability: Availability, body: unknown): Response {
  if (availability === 'network-error') {
    throw new TypeError('fetch failed');
  }
  if (availability === 'http-error') {
    return new Response('unavailable', { status: 503 });
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installProvider(keys: readonly SigningKey[]): ProviderStub {
  const provider: ProviderStub = {
    discovery: 'up',
    jwks: 'up',
    keys,
    calls: { discovery: 0, jwks: 0, other: 0 },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown): Promise<Response> => {
      const url = urlOf(input);
      try {
        if (url === DISCOVERY_URL) {
          provider.calls.discovery += 1;
          return Promise.resolve(
            answer(provider.discovery, { issuer: ISSUER, jwks_uri: JWKS_URL }),
          );
        }
        if (url === JWKS_URL) {
          provider.calls.jwks += 1;
          return Promise.resolve(
            answer(provider.jwks, { keys: provider.keys.map((key) => key.jwk) }),
          );
        }
        provider.calls.other += 1;
        return Promise.reject(new TypeError('fetch failed'));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new TypeError('fetch failed'));
      }
    }),
  );
  return provider;
}

function totalCalls(provider: ProviderStub): number {
  return provider.calls.discovery + provider.calls.jwks + provider.calls.other;
}

function at(secondsAfterStart: number): void {
  vi.setSystemTime(START_MS + secondsAfterStart * 1000);
}

describe('back-channel logout key cache (048 task 7.6, design D8, Q25)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: START_MS });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetches discovery and the key set once for several tokens within the TTL', async () => {
    const provider = installProvider([keyA]);
    const cache = createLogoutKeyCache({ ttlSeconds: TTL_SECONDS });

    for (const seconds of [0, 1, 120, 300, 540]) {
      at(seconds);
      const token = mintLogoutToken(keyA);
      const verified = await verifyLogoutToken(token, expected, cache);
      expect(verified, `token at +${String(seconds)}s is accepted`).not.toBeNull();
    }

    expect(provider.calls.discovery, 'one discovery fetch').toBe(1);
    expect(provider.calls.jwks, 'one JWKS fetch').toBe(1);
    expect(provider.calls.other).toBe(0);
  });

  it('refetches discovery and the key set once the TTL has passed', async () => {
    const provider = installProvider([keyA]);
    const cache = createLogoutKeyCache({ ttlSeconds: TTL_SECONDS });

    at(0);
    expect(await verifyLogoutToken(mintLogoutToken(keyA), expected, cache)).not.toBeNull();
    expect(provider.calls).toEqual({ discovery: 1, jwks: 1, other: 0 });

    at(TTL_SECONDS + 1);
    expect(await verifyLogoutToken(mintLogoutToken(keyA), expected, cache)).not.toBeNull();
    expect(provider.calls, 'the expired copy is refetched').toEqual({
      discovery: 2,
      jwks: 2,
      other: 0,
    });

    // The refreshed copy is cached again for the next tokens.
    at(TTL_SECONDS + 30);
    expect(await verifyLogoutToken(mintLogoutToken(keyA), expected, cache)).not.toBeNull();
    expect(provider.calls).toEqual({ discovery: 2, jwks: 2, other: 0 });
  });

  it('refreshes the key set for an unknown kid at most once per 60 seconds', async () => {
    const provider = installProvider([keyA]);
    const cache = createLogoutKeyCache({ ttlSeconds: TTL_SECONDS });

    // GIVEN a cached copy holding only key A.
    at(0);
    expect(await verifyLogoutToken(mintLogoutToken(keyA), expected, cache)).not.toBeNull();
    expect(provider.calls.jwks).toBe(1);

    // The provider rotates in key B and key C.
    provider.keys = [keyA, keyB, keyC];

    // WHEN a token names unknown kid B (within the TTL): one refresh, and B verifies.
    at(61);
    const beforeFirstRefresh = provider.calls.jwks;
    expect(
      await verifyLogoutToken(mintLogoutToken(keyB), expected, cache),
      'a token signed by the newly published key is accepted after the refresh',
    ).not.toBeNull();
    expect(provider.calls.jwks - beforeFirstRefresh, 'exactly one JWKS refresh').toBe(1);

    // WHEN, within 60 seconds of that refresh, another unknown kid arrives: no fetch at all,
    // and the token is invalid (even though the provider would now serve key C).
    at(61 + 30);
    const callsBeforeLimited = totalCalls(provider);
    const cacheMissProbe = {
      ...keyC,
      kid: 'key-unknown',
    };
    expect(
      await verifyLogoutToken(mintLogoutToken(cacheMissProbe), expected, cache),
      'a second unknown kid within 60 s is invalid',
    ).toBeNull();
    expect(totalCalls(provider) - callsBeforeLimited, 'no refetch within 60 s').toBe(0);

    // Key C was served by the refresh at +61s, so it is no longer unknown: accepted from the
    // cache, still without a fetch.
    expect(await verifyLogoutToken(mintLogoutToken(keyC), expected, cache)).not.toBeNull();
    expect(totalCalls(provider) - callsBeforeLimited).toBe(0);

    // A known kid keeps verifying from the unexpired copy, without a fetch.
    expect(await verifyLogoutToken(mintLogoutToken(keyA), expected, cache)).not.toBeNull();
    expect(totalCalls(provider) - callsBeforeLimited).toBe(0);
  });

  it('a second unknown kid within 60 seconds of a refresh is not refetched even when it would verify', async () => {
    const provider = installProvider([keyA]);
    const cache = createLogoutKeyCache({ ttlSeconds: TTL_SECONDS });

    at(0);
    expect(await verifyLogoutToken(mintLogoutToken(keyA), expected, cache)).not.toBeNull();

    // First unknown kid (B) while the provider still publishes only key A: one refresh,
    // which cannot find B, so the token is invalid.
    at(61);
    const jwksBefore = provider.calls.jwks;
    expect(await verifyLogoutToken(mintLogoutToken(keyB), expected, cache)).toBeNull();
    expect(provider.calls.jwks - jwksBefore, 'the first unknown kid refreshes once').toBe(1);

    // The provider now publishes key C, but a second unknown kid within 60 s does not
    // refetch, so C is still unknown and its token is invalid.
    provider.keys = [keyA, keyC];
    at(61 + 59);
    const callsBefore = totalCalls(provider);
    expect(
      await verifyLogoutToken(mintLogoutToken(keyC), expected, cache),
      'rate-limited unknown kid is invalid',
    ).toBeNull();
    expect(totalCalls(provider) - callsBefore, 'no refetch within 60 s').toBe(0);

    // Once 60 seconds have passed since the last refresh (still within the TTL), an unknown
    // kid may refresh again, and C verifies.
    at(61 + 61);
    const jwksBeforeSecondRefresh = provider.calls.jwks;
    expect(await verifyLogoutToken(mintLogoutToken(keyC), expected, cache)).not.toBeNull();
    expect(provider.calls.jwks - jwksBeforeSecondRefresh, 'one refresh after 60 s').toBe(1);
  });

  it('never uses an expired copy: after the TTL with the provider down, a token signed by a previously cached key is invalid', async () => {
    for (const failure of [
      { discovery: 'network-error', jwks: 'up' },
      { discovery: 'http-error', jwks: 'up' },
      { discovery: 'up', jwks: 'network-error' },
      { discovery: 'up', jwks: 'http-error' },
    ] as const) {
      const label = `discovery ${failure.discovery}, jwks ${failure.jwks}`;
      at(0);
      const provider = installProvider([keyA]);
      const cache = createLogoutKeyCache({ ttlSeconds: TTL_SECONDS });

      expect(
        await verifyLogoutToken(mintLogoutToken(keyA), expected, cache),
        `${label}: accepted while the copy is fresh`,
      ).not.toBeNull();

      // The copy expires and the provider becomes unreachable.
      provider.discovery = failure.discovery;
      provider.jwks = failure.jwks;
      at(TTL_SECONDS + 1);

      const callsBefore = totalCalls(provider);
      const outcome = verifyLogoutToken(mintLogoutToken(keyA), expected, cache);
      await expect(outcome, `${label}: never throws`).resolves.toBeNull();
      expect(
        totalCalls(provider) - callsBefore,
        `${label}: the expired copy is not trusted, a refetch is attempted`,
      ).toBeGreaterThanOrEqual(1);

      // Still invalid on the next delivery while the provider stays down.
      at(TTL_SECONDS + 120);
      await expect(
        verifyLogoutToken(mintLogoutToken(keyA), expected, cache),
        `${label}: still invalid later`,
      ).resolves.toBeNull();

      vi.unstubAllGlobals();
    }
  });

  it('Unavailable signing keys fail closed', async () => {
    for (const failure of [
      { discovery: 'network-error', jwks: 'up' },
      { discovery: 'http-error', jwks: 'up' },
      { discovery: 'up', jwks: 'network-error' },
      { discovery: 'up', jwks: 'http-error' },
    ] as const) {
      const label = `discovery ${failure.discovery}, jwks ${failure.jwks}`;
      // GIVEN no cached discovery document or key set (a fresh cache) ...
      at(0);
      const provider = installProvider([keyA]);
      const cache = createLogoutKeyCache({ ttlSeconds: TTL_SECONDS });
      // ... and a provider that cannot be reached.
      provider.discovery = failure.discovery;
      provider.jwks = failure.jwks;

      // WHEN a (validly signed) logout token is received
      const outcome = verifyLogoutToken(mintLogoutToken(keyA), expected, cache);

      // THEN it is rejected (the `invalid` outcome, so no session is revoked), never
      // accepted, and the verifier does not throw.
      await expect(outcome, `${label}: rejected, never throws`).resolves.toBeNull();
      expect(
        provider.calls.discovery,
        `${label}: the keys were looked for, not skipped`,
      ).toBeGreaterThanOrEqual(1);

      // A failed fetch is not cached as a success: once the provider is back, a token
      // verifies against freshly fetched keys.
      provider.discovery = 'up';
      provider.jwks = 'up';
      at(61);
      expect(
        await verifyLogoutToken(mintLogoutToken(keyA), expected, cache),
        `${label}: accepted once the provider answers`,
      ).not.toBeNull();

      vi.unstubAllGlobals();
    }
  });

  it('runs the cheap claim checks before any discovery or JWKS fetch, even with an empty cache', async () => {
    const provider = installProvider([keyA]);
    const cache = createLogoutKeyCache({ ttlSeconds: TTL_SECONDS });

    const cheapFailures: Record<string, string> = {
      'iss is not the issuer': mintLogoutToken(keyA, { iss: 'https://evil.example.test' }),
      'aud is not the client': mintLogoutToken(keyA, { aud: 'someone-else' }),
      'carries a nonce': mintLogoutToken(keyA, { nonce: 'n' }),
      'neither sid nor sub': mintLogoutToken(keyA, { sid: undefined }),
    };
    for (const [reason, token] of Object.entries(cheapFailures)) {
      expect(await verifyLogoutToken(token, expected, cache), reason).toBeNull();
    }
    expect(totalCalls(provider), 'no outbound call for a cheap failure').toBe(0);
  });
});
