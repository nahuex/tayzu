/**
 * Integration test for task 23.1 (openspec/changes/002-auth-and-rbac; design
 * Q34, D8, D9; `specs/auth-and-rbac/spec.md`, requirements "Three-tier role
 * baseline" and "Ownership resolution").
 *
 * Task 23.1: "`resolveContext` builds `principal.teams` and
 * `principal.moderatedBlueprints` from the caller's `_user` entity and its
 * team relations, replacing the hard-coded empty arrays, and fails closed
 * (`principal` absent, so Cerbos denies) when the entity or relations are
 * unreadable."
 *
 * NOTE: no spec scenario carries these titles verbatim; they are the three
 * cases the task's Verify clause fixes. Their GIVEN/WHEN/THEN come from Q26
 * ("filled only by `resolveContext` ..., plus the `_user` entity's teams and
 * moderated blueprints, never from input. Missing or empty `principal` makes
 * Cerbos deny, so the operation fails closed with `AUTH_FORBIDDEN`") and Q34.
 *
 * ## Harness
 *
 * The app is built by the production bootstrap, `createAppFromEnv(env)`, and
 * every request goes through Fastify (`app.app.inject`), never
 * `auth.handler` for the operation under test. `@tayzu/db`'s `createPool` is
 * mocked to hand out the harness pools (same pattern as
 * `bootstrap-wiring.int.test.ts`); the app pool is wrapped so a test can make
 * reads of `catalog_entity` fail. `@tayzu/authz`'s `createCerbosClient` is
 * wrapped so the principal the pipeline sends to the real Cerbos container
 * (`localhost:3593`) is recorded: that is the observable for `teams` and
 * `moderatedBlueprints`. Every Better Auth call carries a fresh random
 * `x-forwarded-for`.
 *
 * The test seeds the `_user` and `_team` entities itself, as the `system`
 * actor, through `createUserSync` and the entity service: the app does not
 * sync users yet, and it is the state a synced tenant would be in.
 *
 * ## Production symbols and shapes expected (assumptions, to confirm)
 *
 * - `createContextResolver` (wired by `createApp`, no new option is visible
 *   here) fills `principal.teams` with the identifiers of the `_team`
 *   entities the caller's `_user` entity (identifier = the user's email, the
 *   `createUserSync` convention) points to through a relation named `teams`
 *   (many, target blueprint `_team`), and `principal.moderatedBlueprints`
 *   with the `_user` entity's `moderatedBlueprints` property. The relation
 *   name `teams` is an assumption: the design does not name it. If production
 *   declares the relation on `_user` itself, this test keeps working (it adds
 *   the relation only when absent).
 * - The resolver reads the entity through the `tayzu_app` pool under the
 *   caller's tenant (`withTenantTransaction`), since `@tayzu/auth` has no
 *   grants on catalog tables.
 * - A read failure yields no `principal`, never an exception that changes the
 *   error class: the next operation fails with `403 AUTH_FORBIDDEN`.
 *
 * ## Why this fails right now
 *
 * `context-resolver.ts` hard-codes `teams: []` and `moderatedBlueprints: []`,
 * so the recorded principal lacks the teams and the moderated blueprint
 * (assertion failures), and an unreadable `_user` entity is not even read, so
 * the next operation succeeds instead of `AUTH_FORBIDDEN` (assertion failure).
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';

interface RecordedPrincipal {
  readonly id: string;
  readonly roles: readonly string[];
  readonly attr: Readonly<Record<string, unknown>>;
}

const state = vi.hoisted(() => ({
  pools: new Map<string, unknown>(),
  recorded: [] as unknown[],
  failEntityReads: false,
}));

vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return {
    ...actual,
    createPool: vi.fn((url: string) => {
      const role = url.includes('tayzu_auth') ? 'auth' : 'app';
      return state.pools.get(role) as object;
    }),
  };
});

vi.mock('@tayzu/authz', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/authz')>();
  return {
    ...actual,
    createCerbosClient: (options: Parameters<typeof actual.createCerbosClient>[0]) => {
      const real = actual.createCerbosClient(options);
      return new Proxy(real, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          const method = value as (...args: unknown[]) => unknown;
          if (prop === 'checkResources' || prop === 'planResources') {
            return (...args: unknown[]) => {
              state.recorded.push((args[0] as { principal: unknown }).principal);
              return method.apply(target, args);
            };
          }
          return method.bind(target);
        },
      });
    },
  };
});

import { createEntityService, createBlueprintService, createUserSync } from '@tayzu/catalog';
import { createCerbosClient } from '@tayzu/authz';

import { createAppFromEnv } from './bootstrap.js';
import type { App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const TEST_PASSWORD = 'correct horse battery staple';

const ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://tayzu_app:pw@db.invalid:5432/tayzu?sslmode=verify-full',
  AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@db.invalid:5432/tayzu?sslmode=verify-full',
  BETTER_AUTH_SECRET: TEST_SECRET,
  CERBOS_ADDRESS: 'localhost:3593',
  ALLOWED_ORIGINS: ORIGIN,
};

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** Wraps the app pool so reads of `catalog_entity` fail while `state.failEntityReads` is set. */
function poisonable(pool: Pool): Pool {
  const failing = (sql: unknown): boolean => {
    const text = typeof sql === 'string' ? sql : (sql as { text?: string } | null)?.text;
    return state.failEntityReads && typeof text === 'string' && text.includes('catalog_entity');
  };
  const wrapClient = (client: object): object =>
    new Proxy(client, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        const method = value as (...args: unknown[]) => unknown;
        if (prop === 'query') {
          return (...args: unknown[]) =>
            failing(args[0])
              ? Promise.reject(new Error('simulated unreadable _user entity'))
              : method.apply(target, args);
        }
        return method.bind(target);
      },
    });
  return new Proxy(pool, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (prop === 'end') return () => Promise.resolve();
      if (prop === 'connect') {
        return async (...args: unknown[]) =>
          wrapClient((await method.apply(target, args)) as object);
      }
      if (prop === 'query') {
        return (...args: unknown[]) =>
          failing(args[0])
            ? Promise.reject(new Error('simulated unreadable _user entity'))
            : method.apply(target, args);
      }
      return method.bind(target);
    },
  });
}

describe('resolveContext builds the principal from the `_user` entity (task 23.1, Q34, D8, D9)', () => {
  let app: App;
  let appPool: Pool;
  let system: (tenantId: string) => {
    tenantId: string;
    actor: { type: 'system'; id: string };
    principal: { roles: ['admin'] };
  };
  const entities = () => createEntityService({ pool: appPool, authz: createCerbosClient(cerbos) });
  const blueprints = () =>
    createBlueprintService({ pool: appPool, authz: createCerbosClient(cerbos) });
  const cerbos = { address: 'localhost:3593', tls: false };

  beforeAll(async () => {
    const pools = await harnessPools();
    appPool = poisonable(pools.appPool);
    state.pools.set('app', appPool);
    state.pools.set('auth', pools.authPool);
    app = await createAppFromEnv(ENV);
    system = (tenantId) => ({
      tenantId,
      actor: { type: 'system', id: 'principal-test-seed' },
      principal: { roles: ['admin'] },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    state.pools.clear();
  }, 60_000);

  beforeEach(() => {
    state.failEntityReads = false;
    state.recorded.length = 0;
  });

  async function newTenant(): Promise<{ organizationId: string }> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Principal Owner',
      email: `principal-owner-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Principal Org ${suffix}`,
      organizationSlug: `principal-${suffix}`,
      ip: randomIp(),
    });
    return { organizationId: tenant.organizationId };
  }

  /** Bootstraps the system blueprints (through the user sync) and makes sure `_user` has a `teams` relation to `_team`. */
  async function prepareUserBlueprint(organizationId: string): Promise<void> {
    await createUserSync({ pool: appPool, authz: createCerbosClient(cerbos) }).upsertUser({
      tenantId: organizationId,
      email: `bootstrap-${randomUUID()}@example.test`,
      name: 'Bootstrap',
    });
    const current = await blueprints().get(system(organizationId), { identifier: '_user' });
    if (current.relations['teams'] !== undefined) return;
    await blueprints().update(system(organizationId), {
      identifier: '_user',
      title: current.title,
      schema: current.schema,
      relations: {
        ...current.relations,
        teams: { title: { en: 'Teams' }, target: '_team', many: true },
      },
    } as never);
  }

  async function createTeam(organizationId: string, identifier: string): Promise<void> {
    await entities().create(system(organizationId), {
      blueprint: '_team',
      identifier,
      title: identifier,
    });
  }

  /** A `member` of the organization, signed in, with a synced `_user` entity. */
  async function newMember(
    organizationId: string,
    seed: { teams?: string[]; moderatedBlueprints?: string[] },
  ): Promise<{ cookie: string; userId: string }> {
    const email = `principal-member-${randomUUID()}@example.test`;
    const created = await createAdminUser(app.auth, {
      name: 'Principal Member',
      email,
      password: TEST_PASSWORD,
    });
    await (
      app.auth.api as {
        addMember(args: {
          body: { userId: string; organizationId: string; role: string };
        }): Promise<unknown>;
      }
    ).addMember({ body: { userId: created.userId, organizationId, role: 'member' } });
    await createUserSync({ pool: appPool, authz: createCerbosClient(cerbos) }).upsertUser({
      tenantId: organizationId,
      email,
      name: 'Principal Member',
      portRole: 'member',
      status: 'Active',
    });
    await entities().upsert(system(organizationId), {
      blueprint: '_user',
      identifier: email,
      title: 'Principal Member',
      mode: 'merge',
      spec: {
        properties: { moderatedBlueprints: seed.moderatedBlueprints ?? [] },
        relations: { teams: seed.teams ?? [] },
      },
    });
    const signedIn = await signInAdminUser(app.auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    return { cookie: signedIn.cookie, userId: created.userId };
  }

  /** The next operation: a read every member may perform (`catalog_blueprint` `list`). */
  function nextOperation(cookie: string) {
    return app.app.inject({ method: 'GET', url: '/v1/blueprints', headers: { cookie } });
  }

  function principalsOf(userId: string): RecordedPrincipal[] {
    return (state.recorded as RecordedPrincipal[]).filter((principal) => principal.id === userId);
  }

  it('A member of two teams gets both teams in the principal', async () => {
    // GIVEN a member whose `_user` entity relates to the teams team-a and team-b
    const { organizationId } = await newTenant();
    await prepareUserBlueprint(organizationId);
    await createTeam(organizationId, 'team-a');
    await createTeam(organizationId, 'team-b');
    await createTeam(organizationId, 'team-c');
    const member = await newMember(organizationId, { teams: ['team-a', 'team-b'] });
    // AND another member of only team-c, to show the teams are per caller
    const other = await newMember(organizationId, { teams: ['team-c'] });

    // WHEN the member performs an operation through the app
    const response = await nextOperation(member.cookie);
    expect(response.statusCode, 'precondition: a member may list blueprints').toBe(200);

    // THEN the principal Cerbos receives carries exactly both teams, the
    // `member` role, and no moderated blueprint
    const sent = principalsOf(member.userId);
    expect(sent.length).toBeGreaterThan(0);
    for (const principal of sent) {
      expect(principal.roles).toEqual(['member']);
      expect([...(principal.attr['teams'] as string[])].sort()).toEqual(['team-a', 'team-b']);
      expect(principal.attr['moderatedBlueprints']).toEqual([]);
    }

    // AND the other member's principal carries only its own team
    expect((await nextOperation(other.cookie)).statusCode).toBe(200);
    for (const principal of principalsOf(other.userId)) {
      expect(principal.attr['teams']).toEqual(['team-c']);
    }
  }, 120_000);

  it('A moderator of one blueprint gets that blueprint in the principal', async () => {
    // GIVEN a member whose `_user` entity lists the blueprint `service` as moderated
    const { organizationId } = await newTenant();
    await prepareUserBlueprint(organizationId);
    const moderator = await newMember(organizationId, { moderatedBlueprints: ['service'] });

    // WHEN the member performs an operation through the app
    const response = await nextOperation(moderator.cookie);
    expect(response.statusCode).toBe(200);

    // THEN the principal carries exactly that blueprint, and no team
    const sent = principalsOf(moderator.userId);
    expect(sent.length).toBeGreaterThan(0);
    for (const principal of sent) {
      expect(principal.roles).toEqual(['member']);
      expect(principal.attr['moderatedBlueprints']).toEqual(['service']);
      expect(principal.attr['teams']).toEqual([]);
    }
  }, 120_000);

  it('An unreadable `_user` entity fails closed with AUTH_FORBIDDEN on the next operation', async () => {
    // GIVEN a member with a `_user` entity, whose session is valid and who can
    // perform an operation while the entity is readable
    const { organizationId } = await newTenant();
    await prepareUserBlueprint(organizationId);
    await createTeam(organizationId, 'team-a');
    const member = await newMember(organizationId, { teams: ['team-a'] });
    expect((await nextOperation(member.cookie)).statusCode, 'precondition').toBe(200);

    // WHEN the `_user` entity (or its relations) cannot be read
    state.failEntityReads = true;
    state.recorded.length = 0;
    const response = await nextOperation(member.cookie);

    // THEN the principal is absent, so the operation is denied: AUTH_FORBIDDEN
    expect(response.statusCode).toBe(403);
    expect(response.json<{ code?: unknown }>().code).toBe('AUTH_FORBIDDEN');
    // AND no Cerbos check carried a principal for this caller
    expect(principalsOf(member.userId)).toEqual([]);

    // AND once the entity is readable again the caller is served (the failure
    // is not remembered)
    state.failEntityReads = false;
    expect((await nextOperation(member.cookie)).statusCode).toBe(200);
  }, 120_000);
});
