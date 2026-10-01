/**
 * Integration test for task 11.7 (design D13 "Body size limits").
 *
 * Task 11.7: "Fastify's native `bodyLimit` configured, composing with 001's
 * `CatalogLimits` byte-size check. Verify: `body-limit.int.test.ts` covers an
 * oversized request being rejected by Fastify before `CatalogLimits` runs (a
 * spy shows the catalog validator is never invoked)."
 *
 * Design D13: "Fastify's native `bodyLimit` ..., composing with 001's own
 * `CatalogLimits` byte-size check as a second, cheaper layer."
 *
 * ## Production symbols expected
 *
 * - `CreateAppOptions.bodyLimit?: number` (`./server.js`): the maximum request
 *   body size in bytes, passed to `Fastify({ bodyLimit })`. The host supplies
 *   it (env read in bootstrap, never here). Fastify answers an oversized body
 *   with 413 before any route handler runs.
 *
 * ## The spy
 *
 * `parseBlueprintDefinition` (`packages/catalog/src/domain/blueprint-definition.ts`)
 * is the catalog validator `blueprints.create` calls. It is wrapped (calls
 * through to the original) via `vi.mock` on the module's file path, which is
 * the same module instance the service layer imports.
 *
 * ## Why this fails right now
 *
 * `bodyLimit` is not passed to Fastify, so the oversized body (still below
 * Fastify's 1 MiB default) is accepted and reaches the catalog validator: the
 * status is not 413 and the spy was called. The "small body" control is
 * expected to pass already; it proves the spy observes real validator calls.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const validatorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../packages/catalog/src/domain/blueprint-definition.js', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../../../packages/catalog/src/domain/blueprint-definition.js')
    >();
  return {
    ...original,
    parseBlueprintDefinition: (...args: Parameters<typeof original.parseBlueprintDefinition>) => {
      validatorSpy(...args);
      return original.parseBlueprintDefinition(...args);
    },
  };
});

import {
  bootstrapTestTenant,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { CSRF_HEADERS } from './__fixtures__/csrf.js';
import { enrolledAdminSession } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

const TEST_PASSWORD = 'correct horse battery staple';
const ALLOWED_ORIGIN = 'https://app.tayzu.test';
const BODY_LIMIT_BYTES = 4096;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

const emptySchema = { properties: {}, required: [] };

describe('apps/api body size limit (task 11.7)', () => {
  let app: App;
  let cookie: string;

  async function provisionTenant(): Promise<BootstrappedTenant> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Body Limit User',
      email: `body-limit-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Body Limit Org ${suffix}`,
      organizationSlug: `body-limit-org-${suffix}`,
      ip: randomIp(),
    });
    return enrolledAdminSession(app, tenant, { password: TEST_PASSWORD, origin: ALLOWED_ORIGIN });
  }

  function createBlueprint(payload: string) {
    return app.app.inject({
      method: 'POST',
      url: '/v1/blueprints',
      headers: {
        cookie,
        origin: ALLOWED_ORIGIN,
        'x-forwarded-for': randomIp(),
        'content-type': 'application/json',
        ...CSRF_HEADERS,
      },
      payload,
    });
  }

  beforeAll(async () => {
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
      bodyLimit: BODY_LIMIT_BYTES,
    });
    const tenant = await provisionTenant();
    cookie = tenant.cookie;
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  beforeEach(() => {
    validatorSpy.mockClear();
  });

  it('a request within the configured limit reaches the catalog validator (control)', async () => {
    const response = await createBlueprint(
      JSON.stringify({
        identifier: 'small-body',
        title: { en: 'Small body' },
        schema: emptySchema,
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(validatorSpy).toHaveBeenCalled();
  }, 60_000);

  it('An oversized request is rejected by Fastify before CatalogLimits runs', async () => {
    const oversized = JSON.stringify({
      identifier: 'big-body',
      title: { en: 'Big body' },
      description: { en: 'x'.repeat(BODY_LIMIT_BYTES * 2) },
      schema: emptySchema,
    });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(BODY_LIMIT_BYTES);

    const response = await createBlueprint(oversized);

    expect(response.statusCode).toBe(413);
    expect(validatorSpy).not.toHaveBeenCalled();

    // The operation did not run: the blueprint does not exist.
    const lookup = await app.app.inject({
      method: 'GET',
      url: '/v1/blueprints/big-body',
      headers: { cookie, origin: ALLOWED_ORIGIN, 'x-forwarded-for': randomIp() },
    });
    expect(lookup.statusCode).toBe(404);
  }, 60_000);

  /**
   * Task 26.2 (design Q66, D13): a body-bearing `/v1/*` request whose content
   * type is not `application/json` answers 415 before the body is read.
   *
   * Production behavior expected: the `*` catch-all content-type parser in
   * `server.ts` (which lets Fastify skip body-limit enforcement for any
   * non-JSON type) must stop accepting `/v1/*` bodies; a non-JSON content type
   * on a body-bearing `/v1/*` request is refused with 415 (Fastify's
   * `FST_ERR_CTP_INVALID_MEDIA_TYPE`, or an explicit preParsing/onRequest
   * guard). No new options or symbols are required.
   *
   * Each body is oversized (above `BODY_LIMIT_BYTES`) AND would be a valid
   * blueprint if read as JSON, so a 413 or a 200 shows the body was handled
   * rather than refused up front; the spy and the follow-up lookup prove the
   * operation never ran.
   */
  describe('non-JSON content types on /v1/* (task 26.2)', () => {
    const cases: readonly { name: string; contentType: string }[] = [
      { name: 'text/plain', contentType: 'text/plain' },
      {
        name: 'multipart/form-data',
        contentType: 'multipart/form-data; boundary=----tayzu-boundary',
      },
      { name: 'application/octet-stream', contentType: 'application/octet-stream' },
    ];

    for (const { name, contentType } of cases) {
      it(`An oversized ${name} body answers 415 before the body is read`, async () => {
        const identifier = `non-json-${randomUUID()}`;
        const oversized = JSON.stringify({
          identifier,
          title: { en: 'Non JSON body' },
          description: { en: 'x'.repeat(BODY_LIMIT_BYTES * 2) },
          schema: emptySchema,
        });
        expect(Buffer.byteLength(oversized)).toBeGreaterThan(BODY_LIMIT_BYTES);

        const response = await app.app.inject({
          method: 'POST',
          url: '/v1/blueprints',
          headers: {
            cookie,
            origin: ALLOWED_ORIGIN,
            'x-forwarded-for': randomIp(),
            'content-type': contentType,
            ...CSRF_HEADERS,
          },
          payload: oversized,
        });

        expect(response.statusCode).toBe(415);
        expect(validatorSpy).not.toHaveBeenCalled();

        const lookup = await app.app.inject({
          method: 'GET',
          url: `/v1/blueprints/${identifier}`,
          headers: { cookie, origin: ALLOWED_ORIGIN, 'x-forwarded-for': randomIp() },
        });
        expect(lookup.statusCode).toBe(404);
      }, 60_000);
    }

    it('A JSON body still answers normally', async () => {
      const response = await createBlueprint(
        JSON.stringify({
          identifier: `json-still-ok-${randomUUID()}`,
          title: { en: 'JSON still fine' },
          schema: emptySchema,
        }),
      );
      expect(response.statusCode).toBe(200);
      expect(validatorSpy).toHaveBeenCalled();
    }, 60_000);
  });
});
