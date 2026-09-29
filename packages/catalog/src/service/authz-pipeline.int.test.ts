/**
 * Integration tests for task 9.1 (openspec/changes/002-auth-and-rbac, design
 * D7, D10, D14 and Resolved decisions Q26/Q27; spec auth-and-rbac,
 * "Authorization is decided by Cerbos and fails closed").
 *
 * Every test runs end-to-end through a real catalog operation
 * (`createBlueprintService(...).create`, `createEntityService(...).get`), a
 * real PostgreSQL and the real Cerbos container on localhost:3593 with the
 * repo's `policies/`.
 *
 * ## Production symbols assumed (none of them exists yet)
 *
 * - `CatalogContext.principal?: { roles: readonly string[]; teams?: readonly
 *   string[]; moderatedBlueprints?: readonly string[] }`, host-supplied and
 *   passed through `parseCatalogContext` (Q26). Missing or empty `roles`
 *   makes Cerbos deny; the pipeline never invents a default role.
 * - `createBlueprintService({ pool, authz })` and `createEntityService({ pool,
 *   authz })`, where `authz` is a `CerbosClient` from `@tayzu/authz` (Q27).
 * - `defineCatalogOperation` requires an `authorization` declaration; the
 *   pipeline runs `CheckResources` right after context validation and before
 *   the tenant transaction opens (task 9.1). Blueprint create -> kind
 *   `catalog_blueprint`, action `create`; entity get -> kind `catalog_entity`,
 *   action `view`.
 * - A deny throws an error whose `code` is `AUTH_FORBIDDEN`. Which class
 *   carries it is left open (the tests read only `.code`), and it is not
 *   `CATALOG_NOT_FOUND`.
 * - Telemetry (design D14): the WARN log `catalog.security.authz_denied`
 *   (`tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`,
 *   `tayzu.authz.resource.kind`, `tayzu.authz.action`) and the counter
 *   `tayzu.authz.decisions` (`tayzu.tenant.id`, `tayzu.authz.resource.kind`,
 *   `tayzu.authz.action`, `tayzu.authz.decision` = `allow` | `deny`).
 */
import { createCerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Import order is load-bearing: the harness must register before any module
// that creates instruments at import time (see pipeline.int.test.ts).
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
} from './__fixtures__/blueprint-test-helpers.js';
import { blueprintInput, entityInput } from './__fixtures__/entity-a-test-helpers.js';
import {
  finishedLogRecords,
  sumDataPoints,
  type CapturedSumPoint,
} from './__fixtures__/telemetry-assertions.js';
import { createBlueprintService } from './blueprints.js';
import { createEntityService } from './entities.js';

const CERBOS_ADDRESS = 'localhost:3593';

type Roles = readonly string[];

function harnessOrThrow(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(`harness registration failed: ${String(registration.error)}`, {
      cause: registration.error,
    });
  }
  return registration.harness;
}

/** A host-supplied context. `principal` is omitted entirely when `roles` is undefined. */
function context(tenantId: string, roles?: Roles, actorId = 'user-1'): Record<string, unknown> {
  const base = { tenantId, actor: { type: 'user', id: actorId } };
  return roles === undefined ? base : { ...base, principal: { roles } };
}

/** Reads a thrown value's `code` without assuming its class. */
async function thrownCode(promise: Promise<unknown>): Promise<unknown> {
  const thrown: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown, 'expected the operation to reject').toBeDefined();
  return (thrown as { code?: unknown }).code;
}

function decisions(
  harness: TelemetryTestHarness,
  tenantId: string,
  decision: 'allow' | 'deny',
): CapturedSumPoint[] {
  return sumDataPoints(harness.metricExporter, 'tayzu.authz.decisions').filter(
    (point) =>
      point.attributes['tayzu.tenant.id'] === tenantId &&
      point.attributes['tayzu.authz.decision'] === decision,
  );
}

describe('catalog authorization stage (task 9.1)', () => {
  const url = databaseUrl();
  // The services run as `tayzu_app` under the real RLS policy (design D6, Q1a).
  const pool = connect(url).$client;
  const ownerDb = connectAsOwner(url);
  const authz = createCerbosClient({ address: CERBOS_ADDRESS, tls: false });
  const blueprints = createBlueprintService({ pool, authz });
  const entities = createEntityService({ pool, authz });

  beforeAll(async () => {
    await runMigrations(ownerDb.$client);
  });

  afterAll(async () => {
    await endQuietly(pool);
    await endQuietly(ownerDb.$client);
  });

  beforeEach(async () => {
    await harnessOrThrow().reset();
  });

  describe('Action with no matching rule is denied', () => {
    it('Action with no matching rule is denied: a member creating a blueprint fails with AUTH_FORBIDDEN and nothing is written', async () => {
      const tenantId = randomTenantId();
      const admin = context(tenantId, ['admin']);

      const code = await thrownCode(
        blueprints.create(context(tenantId, ['member']), blueprintInput('service')),
      );
      expect(code).toBe('AUTH_FORBIDDEN');

      // The handler never ran: the blueprint does not exist for an admin.
      await expectCatalogErrorCode(
        blueprints.get(admin, { identifier: 'service' }),
        'CATALOG_NOT_FOUND',
      );
    });

    it('Action with no matching rule is denied: a role no rule grants fails with AUTH_FORBIDDEN', async () => {
      const tenantId = randomTenantId();
      const code = await thrownCode(
        blueprints.create(context(tenantId, ['nobody']), blueprintInput('service')),
      );
      expect(code).toBe('AUTH_FORBIDDEN');
    });

    it('Action with no matching rule is denied: a missing principal fails closed with AUTH_FORBIDDEN', async () => {
      const tenantId = randomTenantId();
      const code = await thrownCode(
        blueprints.create(context(tenantId), blueprintInput('service')),
      );
      expect(code).toBe('AUTH_FORBIDDEN');
    });

    it('Action with no matching rule is denied: an empty role list fails closed with AUTH_FORBIDDEN', async () => {
      const tenantId = randomTenantId();
      const code = await thrownCode(
        blueprints.create(context(tenantId, []), blueprintInput('service')),
      );
      expect(code).toBe('AUTH_FORBIDDEN');
    });

    it('Action with no matching rule is denied: the deny emits catalog.security.authz_denied and tayzu.authz.decisions{deny}, without tenant free text', async () => {
      const harness = harnessOrThrow();
      const tenantId = randomTenantId();

      await thrownCode(
        blueprints.create(
          context(tenantId, ['member'], 'user-deny'),
          blueprintInput('secret-blueprint-name'),
        ),
      );
      await harness.forceFlush();

      const logs = finishedLogRecords(harness.logExporter, 'catalog.security.authz_denied');
      expect(logs).toHaveLength(1);
      const attributes = logs[0]?.attributes ?? {};
      expect(attributes).toMatchObject({
        'tayzu.tenant.id': tenantId,
        'tayzu.actor.type': 'user',
        'tayzu.actor.id': 'user-deny',
        'tayzu.authz.resource.kind': 'catalog_blueprint',
        'tayzu.authz.action': 'create',
      });
      expect(JSON.stringify(attributes)).not.toContain('secret-blueprint-name');

      const denies = decisions(harness, tenantId, 'deny');
      expect(denies).toHaveLength(1);
      expect(denies[0]?.value).toBe(1);
      expect(denies[0]?.attributes).toMatchObject({
        'tayzu.authz.resource.kind': 'catalog_blueprint',
        'tayzu.authz.action': 'create',
      });
      expect(decisions(harness, tenantId, 'allow')).toHaveLength(0);
    });

    it('Action with no matching rule is denied: an allowed action records an allow decision and no authz_denied log', async () => {
      const harness = harnessOrThrow();
      const tenantId = randomTenantId();

      await blueprints.create(context(tenantId, ['admin']), blueprintInput('service'));
      await harness.forceFlush();

      const allows = decisions(harness, tenantId, 'allow');
      expect(allows).toHaveLength(1);
      expect(allows[0]?.attributes).toMatchObject({
        'tayzu.authz.resource.kind': 'catalog_blueprint',
        'tayzu.authz.action': 'create',
      });
      expect(decisions(harness, tenantId, 'deny')).toHaveLength(0);
      expect(finishedLogRecords(harness.logExporter, 'catalog.security.authz_denied')).toHaveLength(
        0,
      );
    });
  });

  describe('Denied action is distinct from not found', () => {
    it('Denied action is distinct from not found: an in-tenant deny on an existing entity is AUTH_FORBIDDEN, not CATALOG_NOT_FOUND', async () => {
      const harness = harnessOrThrow();
      const tenantId = randomTenantId();
      const admin = context(tenantId, ['admin']);

      await blueprints.create(admin, blueprintInput('service'));
      await entities.create(admin, entityInput('service', 'payments'));

      // The entity exists in the caller's own tenant, but the caller's role
      // does not permit reading it.
      const code = await thrownCode(
        entities.get(context(tenantId, ['nobody']), {
          blueprint: 'service',
          identifier: 'payments',
        }),
      );
      expect(code).toBe('AUTH_FORBIDDEN');
      expect(code).not.toBe('CATALOG_NOT_FOUND');

      await harness.forceFlush();
      const logs = finishedLogRecords(harness.logExporter, 'catalog.security.authz_denied');
      expect(logs.some((log) => log.attributes['tayzu.authz.action'] === 'view')).toBe(true);
    });

    it('Denied action is distinct from not found: a cross-tenant lookup and a missing entity stay CATALOG_NOT_FOUND', async () => {
      const tenantId = randomTenantId();
      const otherTenantId = randomTenantId();
      const admin = context(tenantId, ['admin']);

      await blueprints.create(admin, blueprintInput('service'));
      await entities.create(admin, entityInput('service', 'payments'));

      // An admin of another tenant is allowed by the role, so the lookup
      // reaches the database, where the tenant scope hides the row.
      await expectCatalogErrorCode(
        entities.get(context(otherTenantId, ['admin']), {
          blueprint: 'service',
          identifier: 'payments',
        }),
        'CATALOG_NOT_FOUND',
      );
      await expectCatalogErrorCode(
        entities.get(admin, { blueprint: 'service', identifier: 'missing' }),
        'CATALOG_NOT_FOUND',
      );
    });
  });
});
