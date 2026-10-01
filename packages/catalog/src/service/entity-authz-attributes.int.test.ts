/**
 * Integration test for task 23.2 (openspec/changes/002-auth-and-rbac; design
 * Q34, D9, D10, D11; spec auth-and-rbac, requirements "Three-tier role
 * baseline", "Team ownership" and "Dynamic attribute-based access control").
 *
 * Every test runs through the real catalog operations
 * (`createEntityService(...)`, `createBlueprintService(...)`), a real
 * PostgreSQL and the real Cerbos container on localhost:3593 with the repo's
 * `policies/`. Nothing about the Cerbos request is hand-fed: the outcomes
 * below are only reachable when the operation loads the entity row and sends
 * `ownerTeam`, `createdBy`, `locked` and `tenantId` itself.
 *
 * ## Conventions assumed (the design does not pin them; confirm at green)
 *
 * - Direct team ownership: a blueprint declares a relation named `ownerTeam`
 *   (target `_team`, single-valued); an entity's `spec.relations.ownerTeam`
 *   is its direct owner team. The operation passes
 *   `{ directTeamRelation: 'ownerTeam' }` to `resolveEffectiveOwnerTeam`.
 *   Cerbos receives `ownerTeam` = the team identifier, and no `ownerTeam`
 *   attribute at all when the entity has none.
 * - `createdBy` sent to Cerbos is the entity row's `created_by_id` (the
 *   creating actor's id, which is also the principal id Cerbos compares).
 * - `locked` sent to Cerbos is the boolean `spec.properties.locked` of the
 *   entity (the blueprint declares a boolean property `locked`).
 * - `R.attr.tenantId` is the loaded row's `tenant_id`; for `create` it is the
 *   context tenant.
 * - Attributes are sent on the `catalog_entity` `CheckResources` of get
 *   (`view`), create (`create`), upsert/writeStatus (`update`), delete
 *   (`delete`) and listRelated (`view`).
 */
import { randomUUID } from 'node:crypto';

import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
} from './__fixtures__/blueprint-test-helpers.js';
import { blueprintInput } from './__fixtures__/entity-a-test-helpers.js';
import { createBlueprintService } from './blueprints.js';
import { createEntityService } from './entities.js';
import { bootstrapSystemBlueprints } from './system-blueprints.js';

interface Recorded {
  readonly action: string;
  readonly kind: string;
  readonly id: string;
  readonly attr: Readonly<Record<string, unknown>>;
}

interface CheckRequest {
  readonly resources: readonly {
    readonly resource: { kind: string; id: string; attr?: Record<string, unknown> };
    readonly actions: readonly string[];
  }[];
}

/** Wraps the real client and records every `catalog_entity` check it forwards. */
function recordingAuthz(real: CerbosClient, recorded: Recorded[]): CerbosClient {
  return new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (prop === 'checkResources') {
        return (request: CheckRequest) => {
          for (const entry of request.resources) {
            if (entry.resource.kind !== 'catalog_entity') continue;
            for (const action of entry.actions) {
              recorded.push({
                action,
                kind: entry.resource.kind,
                id: entry.resource.id,
                attr: { ...entry.resource.attr },
              });
            }
          }
          return method.call(target, request);
        };
      }
      return method.bind(target);
    },
  });
}

type Principal = {
  roles: string[];
  teams?: string[];
  moderatedBlueprints?: string[];
};

function ctx(tenantId: string, actorId: string, principal: Principal): Record<string, unknown> {
  return { tenantId, actor: { type: 'user', id: actorId }, principal };
}

const ADMIN: Principal = { roles: ['admin'] };

async function thrownCode(promise: Promise<unknown>): Promise<unknown> {
  const thrown: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown, 'expected the operation to reject').toBeDefined();
  return (thrown as { code?: unknown }).code;
}

describe('entity operations authorize with entity attributes (task 23.2, Q34, D9-D11)', () => {
  const url = databaseUrl();
  const pool = connect(url).$client;
  const ownerDb = connectAsOwner(url);
  const recorded: Recorded[] = [];
  const real = createCerbosClient({ address: 'localhost:3593', tls: false });
  const authz = recordingAuthz(real, recorded);
  const blueprints = createBlueprintService({ pool, authz });
  const entities = createEntityService({ pool, authz });

  beforeAll(async () => {
    await runMigrations(ownerDb.$client);
  });

  afterAll(async () => {
    await endQuietly(pool);
    await endQuietly(ownerDb.$client);
  });

  /** A tenant with `service` and `deployment` blueprints (each with `ownerTeam` and `locked`) and teams `platform` and `other`. */
  async function newTenant(): Promise<string> {
    const tenantId = randomTenantId();
    await bootstrapSystemBlueprints({ pool, authz: real }, tenantId);
    const system = {
      tenantId,
      actor: { type: 'system', id: 'authz-attributes-seed' },
      principal: ADMIN,
    };
    for (const team of ['platform', 'other']) {
      await entities.create(system, { blueprint: '_team', identifier: team, title: team });
    }
    for (const identifier of ['service', 'deployment']) {
      await blueprints.create(
        ctx(tenantId, 'admin-1', ADMIN),
        blueprintInput(identifier, {
          schema: {
            properties: { locked: { type: 'boolean', title: { en: 'Locked' } } },
            required: [],
          },
          statusSchema: { properties: {} },
          relations: {
            ownerTeam: { title: { en: 'Owner team' }, target: '_team' },
          },
        }),
      );
    }
    return tenantId;
  }

  async function createOwned(
    tenantId: string,
    blueprint: string,
    identifier: string,
    options: { team?: string; locked?: boolean; actorId?: string; principal?: Principal } = {},
  ): Promise<void> {
    await entities.create(ctx(tenantId, options.actorId ?? 'admin-1', options.principal ?? ADMIN), {
      blueprint,
      identifier,
      title: identifier,
      spec: {
        properties: options.locked === undefined ? {} : { locked: options.locked },
        relations: options.team === undefined ? {} : { ownerTeam: options.team },
      },
    });
  }

  function update(_tenantId: string, who: Record<string, unknown>, blueprint: string, id: string) {
    return entities.upsert(who, {
      blueprint,
      identifier: id,
      title: `${id} updated`,
      mode: 'merge',
      spec: { properties: {}, relations: {} },
    });
  }

  it("Non-owning member cannot update another team's entity", async () => {
    const tenantId = await newTenant();
    await createOwned(tenantId, 'service', 'payments', { team: 'platform' });

    const outsider = ctx(tenantId, 'member-outsider', { roles: ['member'], teams: ['other'] });
    expect(await thrownCode(update(tenantId, outsider, 'service', 'payments'))).toBe(
      'AUTH_FORBIDDEN',
    );

    // Control: a member of the owning team is permitted, so the deny above is
    // caused by the ownerTeam attribute and not by the role.
    const insider = ctx(tenantId, 'member-insider', { roles: ['member'], teams: ['platform'] });
    await update(tenantId, insider, 'service', 'payments');
  });

  it('Creating an entity owned by a team the caller does not belong to is denied', async () => {
    const tenantId = await newTenant();
    const outsider = ctx(tenantId, 'member-outsider', { roles: ['member'], teams: ['other'] });
    const create = (who: Record<string, unknown>, identifier: string) =>
      entities.create(who, {
        blueprint: 'service',
        identifier,
        title: identifier,
        spec: { properties: {}, relations: { ownerTeam: 'platform' } },
      });

    expect(await thrownCode(create(outsider, 'payments'))).toBe('AUTH_FORBIDDEN');
    // Nothing was written.
    await expectCatalogErrorCode(
      entities.get(ctx(tenantId, 'admin-1', ADMIN), {
        blueprint: 'service',
        identifier: 'payments',
      }),
      'CATALOG_NOT_FOUND',
    );

    // Control: a member of `platform` may create it.
    const insider = ctx(tenantId, 'member-insider', { roles: ['member'], teams: ['platform'] });
    await create(insider, 'payments');
  });

  describe('upsert of an entity that does not exist yet authorizes create (task 24.4, Q53, Q34)', () => {
    const upsertNew = (
      who: Record<string, unknown>,
      identifier: string,
      relations: Record<string, unknown>,
    ) =>
      entities.upsert(who, {
        blueprint: 'service',
        identifier,
        title: identifier,
        mode: 'merge',
        spec: { properties: {}, relations },
      } as never);

    const exists = async (tenantId: string, identifier: string): Promise<boolean> => {
      const found = await entities
        .get(ctx(tenantId, 'admin-1', ADMIN), { blueprint: 'service', identifier })
        .then(
          () => true,
          (error: unknown) => {
            expect((error as { code?: unknown }).code).toBe('CATALOG_NOT_FOUND');
            return false;
          },
        );
      return found;
    };

    it('Creating an entity owned by a team the caller does not belong to is denied (through entities.upsert)', async () => {
      const tenantId = await newTenant();
      const outsider = ctx(tenantId, 'member-outsider', { roles: ['member'], teams: ['other'] });

      expect(await thrownCode(upsertNew(outsider, 'payments', { ownerTeam: 'platform' }))).toBe(
        'AUTH_FORBIDDEN',
      );
      // Nothing was written.
      expect(await exists(tenantId, 'payments')).toBe(false);

      // Control: a member of `platform` may create it through the same upsert.
      const insider = ctx(tenantId, 'member-insider', { roles: ['member'], teams: ['platform'] });
      await upsertNew(insider, 'payments', { ownerTeam: 'platform' });
      expect(await exists(tenantId, 'payments')).toBe(true);
    });

    it('an upsert-create with no owner team is allowed for a member', async () => {
      const tenantId = await newTenant();
      const member = ctx(tenantId, 'member-1', { roles: ['member'], teams: ['other'] });
      await upsertNew(member, 'unowned', {});
      expect(await exists(tenantId, 'unowned')).toBe(true);
    });

    it('an upsert-create sends a create check with the new entity attributes to Cerbos', async () => {
      const tenantId = await newTenant();
      const member = ctx(tenantId, 'member-1', { roles: ['member'], teams: ['platform'] });
      recorded.length = 0;
      await upsertNew(member, 'fresh', { ownerTeam: 'platform' });

      const create = recorded.find((entry) => entry.action === 'create' && entry.id === 'fresh');
      expect(create, 'a create check for the new entity').toBeDefined();
      expect(create?.attr).toMatchObject({
        tenantId,
        blueprintId: 'service',
        ownerTeam: 'platform',
        createdBy: 'member-1',
        locked: false,
      });
    });

    it('a list-valued ownerTeam is denied on create', async () => {
      const tenantId = await newTenant();
      const member = ctx(tenantId, 'member-1', { roles: ['member'], teams: ['platform'] });

      expect(
        await thrownCode(
          entities.create(member, {
            blueprint: 'service',
            identifier: 'listed',
            title: 'listed',
            spec: { properties: {}, relations: { ownerTeam: ['platform', 'other'] } },
          }),
        ),
      ).toBe('AUTH_FORBIDDEN');
      expect(await exists(tenantId, 'listed')).toBe(false);
    });

    it('a list-valued ownerTeam is denied on upsert-create', async () => {
      const tenantId = await newTenant();
      const member = ctx(tenantId, 'member-1', { roles: ['member'], teams: ['platform'] });

      expect(
        await thrownCode(upsertNew(member, 'listed', { ownerTeam: ['platform', 'other'] })),
      ).toBe('AUTH_FORBIDDEN');
      expect(await exists(tenantId, 'listed')).toBe(false);
    });
  });

  it('Moderator can update entities of a moderated blueprint', async () => {
    const tenantId = await newTenant();
    await createOwned(tenantId, 'service', 'payments', { team: 'platform' });

    const moderator = ctx(tenantId, 'member-moderator', {
      roles: ['member'],
      teams: [],
      moderatedBlueprints: ['service'],
    });
    await update(tenantId, moderator, 'service', 'payments');
  });

  it('Moderator has no extra permission on a non-moderated blueprint', async () => {
    const tenantId = await newTenant();
    await createOwned(tenantId, 'deployment', 'payments-prod', { team: 'platform' });

    const moderator = ctx(tenantId, 'member-moderator', {
      roles: ['member'],
      teams: [],
      moderatedBlueprints: ['service'],
    });
    expect(await thrownCode(update(tenantId, moderator, 'deployment', 'payments-prod'))).toBe(
      'AUTH_FORBIDDEN',
    );
  });

  it('Attribute-based rule grants access a role alone would not (delete-own)', async () => {
    const tenantId = await newTenant();
    const creator = ctx(tenantId, 'member-creator', { roles: ['member'], teams: [] });
    const other = ctx(tenantId, 'member-other', { roles: ['member'], teams: [] });
    await createOwned(tenantId, 'service', 'mine', {
      actorId: 'member-creator',
      principal: { roles: ['member'], teams: [] },
    });
    await createOwned(tenantId, 'service', 'theirs', { actorId: 'admin-1' });

    // Another member cannot delete it: the role alone does not grant delete.
    expect(
      await thrownCode(entities.delete(other, { blueprint: 'service', identifier: 'mine' })),
    ).toBe('AUTH_FORBIDDEN');
    // The creator can, through the createdBy rule; and not someone else's entity.
    expect(
      await thrownCode(entities.delete(creator, { blueprint: 'service', identifier: 'theirs' })),
    ).toBe('AUTH_FORBIDDEN');
    await entities.delete(creator, { blueprint: 'service', identifier: 'mine' });
    await expectCatalogErrorCode(
      entities.get(ctx(tenantId, 'admin-1', ADMIN), { blueprint: 'service', identifier: 'mine' }),
      'CATALOG_NOT_FOUND',
    );
  });

  it('Attribute-based rule denies access a role alone would have granted (locked)', async () => {
    const tenantId = await newTenant();
    await createOwned(tenantId, 'service', 'frozen', { locked: true });
    await createOwned(tenantId, 'service', 'open', { locked: false });

    const member = ctx(tenantId, 'member-1', { roles: ['member'], teams: [] });
    expect(await thrownCode(update(tenantId, member, 'service', 'frozen'))).toBe('AUTH_FORBIDDEN');
    // Control: an unlocked, unowned entity is updatable by the same member.
    await update(tenantId, member, 'service', 'open');
    // An admin can still update the locked entity.
    await update(tenantId, ctx(tenantId, 'admin-2', ADMIN), 'service', 'frozen');
  });

  describe('an update that changes ownerTeam is also authorized with create against the new owner team (task 25.4, Q63, Q34)', () => {
    const reassign = (who: Record<string, unknown>, identifier: string, relations: unknown) =>
      entities.upsert(who, {
        blueprint: 'service',
        identifier,
        title: `${identifier} reassigned`,
        mode: 'merge',
        spec: { properties: {}, relations },
      } as never);

    /** The owner team Cerbos sees for the stored entity, read through a real `get`. */
    const storedOwner = async (tenantId: string, identifier: string): Promise<unknown> => {
      recorded.length = 0;
      await entities.get(ctx(tenantId, 'admin-1', ADMIN), { blueprint: 'service', identifier });
      const view = recorded.find((entry) => entry.action === 'view' && entry.id === identifier);
      expect(view, 'a view check for the entity').toBeDefined();
      return view?.attr.ownerTeam;
    };

    it('a member of team A re-assigning an entity it may update to team B is denied', async () => {
      const tenantId = await newTenant();
      await createOwned(tenantId, 'service', 'payments', { team: 'platform' });
      const member = ctx(tenantId, 'member-a', { roles: ['member'], teams: ['platform'] });

      expect(await thrownCode(reassign(member, 'payments', { ownerTeam: 'other' }))).toBe(
        'AUTH_FORBIDDEN',
      );
      // Nothing was written: the entity still belongs to `platform`.
      expect(await storedOwner(tenantId, 'payments')).toBe('platform');
    });

    it('a member re-assigning an unowned entity it may update to a foreign team is denied', async () => {
      const tenantId = await newTenant();
      await createOwned(tenantId, 'service', 'unowned');
      const member = ctx(tenantId, 'member-a', { roles: ['member'], teams: ['platform'] });

      expect(await thrownCode(reassign(member, 'unowned', { ownerTeam: 'other' }))).toBe(
        'AUTH_FORBIDDEN',
      );
      expect(await storedOwner(tenantId, 'unowned')).toBeUndefined();
    });

    it('a member re-assigning an entity to its own team is allowed', async () => {
      const tenantId = await newTenant();
      await createOwned(tenantId, 'service', 'payments', { team: 'other' });
      // Member of both teams: may update (owns `other`) and may create for `platform`.
      const member = ctx(tenantId, 'member-ab', {
        roles: ['member'],
        teams: ['platform', 'other'],
      });

      await reassign(member, 'payments', { ownerTeam: 'platform' });
      expect(await storedOwner(tenantId, 'payments')).toBe('platform');
    });

    it('a member keeping the owner team is allowed (explicitly and by omission)', async () => {
      const tenantId = await newTenant();
      await createOwned(tenantId, 'service', 'payments', { team: 'platform' });
      const member = ctx(tenantId, 'member-a', { roles: ['member'], teams: ['platform'] });

      await reassign(member, 'payments', { ownerTeam: 'platform' });
      await reassign(member, 'payments', {});
      expect(await storedOwner(tenantId, 'payments')).toBe('platform');
    });

    it('an admin re-assigning an entity to another team is allowed', async () => {
      const tenantId = await newTenant();
      await createOwned(tenantId, 'service', 'payments', { team: 'platform' });

      await reassign(ctx(tenantId, 'admin-2', ADMIN), 'payments', { ownerTeam: 'other' });
      expect(await storedOwner(tenantId, 'payments')).toBe('other');
    });

    it('the extra check is a create check carrying the new owner team', async () => {
      const tenantId = await newTenant();
      await createOwned(tenantId, 'service', 'payments', { team: 'platform' });
      const admin = ctx(tenantId, 'admin-2', ADMIN);

      recorded.length = 0;
      await reassign(admin, 'payments', { ownerTeam: 'other' });
      const create = recorded.find((entry) => entry.action === 'create' && entry.id === 'payments');
      expect(create, 'a create check for the new owner team').toBeDefined();
      expect(create?.attr).toMatchObject({ tenantId, blueprintId: 'service', ownerTeam: 'other' });

      // No create check when the owner does not change.
      recorded.length = 0;
      await reassign(admin, 'payments', { ownerTeam: 'other' });
      expect(recorded.some((entry) => entry.action === 'create')).toBe(false);
    });
  });

  describe('entities.delete with detachReferences authorizes update on every referrer (task 26.1, Q65, Q34)', () => {
    /** A tenant plus a `consumer` blueprint whose optional `dependsOn` points at `service`, and a `service` `ledger` created by `member-creator`. */
    async function referencedTenant(): Promise<string> {
      const tenantId = await newTenant();
      await blueprints.create(
        ctx(tenantId, 'admin-1', ADMIN),
        blueprintInput('consumer', {
          schema: {
            properties: { locked: { type: 'boolean', title: { en: 'Locked' } } },
            required: [],
          },
          statusSchema: { properties: {} },
          relations: {
            ownerTeam: { title: { en: 'Owner team' }, target: '_team' },
            dependsOn: { title: { en: 'Depends on' }, target: 'service', many: true },
          },
        }),
      );
      await createOwned(tenantId, 'service', 'ledger', {
        actorId: 'member-creator',
        principal: { roles: ['member'], teams: ['platform'] },
      });
      return tenantId;
    }

    const creator = (tenantId: string) =>
      ctx(tenantId, 'member-creator', { roles: ['member'], teams: ['platform'] });

    const addReferrer = (
      tenantId: string,
      identifier: string,
      options: { team?: string; locked?: boolean } = {},
    ) =>
      entities.create(ctx(tenantId, 'admin-1', ADMIN), {
        blueprint: 'consumer',
        identifier,
        title: identifier,
        spec: {
          properties: options.locked === undefined ? {} : { locked: options.locked },
          relations: {
            dependsOn: ['ledger'],
            ...(options.team === undefined ? {} : { ownerTeam: options.team }),
          },
        },
      });

    const getAs = (tenantId: string, blueprint: string, identifier: string) =>
      entities.get(ctx(tenantId, 'admin-1', ADMIN), { blueprint, identifier });

    const deleteLedger = (tenantId: string) =>
      entities.delete(creator(tenantId), {
        blueprint: 'service',
        identifier: 'ledger',
        detachReferences: true,
      });

    /** Nothing was detached: the target exists and each referrer still references it at version 1. */
    async function expectNothingDetached(tenantId: string, referrers: string[]): Promise<void> {
      await getAs(tenantId, 'service', 'ledger');
      for (const identifier of referrers) {
        const referrer = await getAs(tenantId, 'consumer', identifier);
        expect(referrer.spec.relations['dependsOn'], identifier).toEqual(['ledger']);
        expect(referrer.version, identifier).toBe(1);
        expect(referrer.generation, identifier).toBe(1);
      }
    }

    it('a member deleting its own entity is refused when a referrer is owned by another team, and nothing is detached', async () => {
      const tenantId = await referencedTenant();
      await addReferrer(tenantId, 'allowed-referrer', { team: 'platform' });
      await addReferrer(tenantId, 'foreign-referrer', { team: 'other' });

      expect(await thrownCode(deleteLedger(tenantId))).toBe('CATALOG_REFERENCE_VIOLATION');
      // Even the referrer the caller may update is untouched: no edge is detached before the deny.
      await expectNothingDetached(tenantId, ['allowed-referrer', 'foreign-referrer']);
    });

    it('a member deleting its own entity is refused when a referrer is locked, and nothing is detached', async () => {
      const tenantId = await referencedTenant();
      await addReferrer(tenantId, 'open-referrer');
      await addReferrer(tenantId, 'locked-referrer', { team: 'platform', locked: true });

      expect(await thrownCode(deleteLedger(tenantId))).toBe('CATALOG_REFERENCE_VIOLATION');
      await expectNothingDetached(tenantId, ['open-referrer', 'locked-referrer']);
    });

    it('the same delete is allowed when every referrer may be updated, and each distinct referrer gets an update check', async () => {
      const tenantId = await referencedTenant();
      await addReferrer(tenantId, 'team-referrer', { team: 'platform' });
      await addReferrer(tenantId, 'unowned-referrer');

      recorded.length = 0;
      await deleteLedger(tenantId);

      await expectCatalogErrorCode(getAs(tenantId, 'service', 'ledger'), 'CATALOG_NOT_FOUND');
      for (const identifier of ['team-referrer', 'unowned-referrer']) {
        const referrer = await getAs(tenantId, 'consumer', identifier);
        expect(referrer.spec.relations['dependsOn'] ?? [], identifier).not.toContain('ledger');
        expect(referrer.version, identifier).toBe(2);
        expect(
          recorded.filter((entry) => entry.action === 'update' && entry.id === identifier),
          `an update check for ${identifier}`,
        ).toHaveLength(1);
      }
    });

    it('a delete without detachReferences and without referrers does not need update on anything else', async () => {
      const tenantId = await referencedTenant();
      recorded.length = 0;
      await entities.delete(creator(tenantId), { blueprint: 'service', identifier: 'ledger' });
      expect(recorded.some((entry) => entry.action === 'update')).toBe(false);
    });

    describe('status-scope edges are detached without an update check on their observers (task 28.2, Q81, Q65)', () => {
      /** `observer` (owned by team `other`) reports `ledger` through a status relation, written by the system-like admin. */
      const observeLedger = (tenantId: string, identifier: string) =>
        entities.create(ctx(tenantId, 'admin-1', ADMIN), {
          blueprint: 'consumer',
          identifier,
          title: identifier,
          spec: { properties: {}, relations: { ownerTeam: 'other' } },
        });

      const reportStatus = (tenantId: string, identifier: string) =>
        entities.writeStatus(ctx(tenantId, 'admin-1', ADMIN), {
          blueprint: 'consumer',
          identifier,
          relations: { dependsOn: ['ledger'] },
          observedGeneration: 1,
          source: 'test',
        });

      it('a member deleting its entity succeeds when a foreign-team entity observes it through a status relation', async () => {
        const tenantId = await referencedTenant();
        await observeLedger(tenantId, 'foreign-observer');
        await reportStatus(tenantId, 'foreign-observer');
        const before = await getAs(tenantId, 'consumer', 'foreign-observer');
        expect(before.status?.relations['dependsOn'], 'precondition: status edge exists').toEqual([
          'ledger',
        ]);

        recorded.length = 0;
        await deleteLedger(tenantId);

        await expectCatalogErrorCode(getAs(tenantId, 'service', 'ledger'), 'CATALOG_NOT_FOUND');
        const after = await getAs(tenantId, 'consumer', 'foreign-observer');
        expect(after.status?.relations['dependsOn'] ?? []).not.toContain('ledger');
        // The observer is never authorized for update: the edge is system-written (Q81).
        expect(
          recorded.filter((entry) => entry.action === 'update' && entry.id === 'foreign-observer'),
        ).toHaveLength(0);
        // The observer's spec is untouched.
        expect(after.generation).toBe(before.generation);
      });

      it('a spec-scope referrer of another team still blocks the delete, and the status edge is kept', async () => {
        const tenantId = await referencedTenant();
        await observeLedger(tenantId, 'foreign-observer');
        await reportStatus(tenantId, 'foreign-observer');
        await addReferrer(tenantId, 'foreign-referrer', { team: 'other' });

        expect(await thrownCode(deleteLedger(tenantId))).toBe('CATALOG_REFERENCE_VIOLATION');

        await getAs(tenantId, 'service', 'ledger');
        const referrer = await getAs(tenantId, 'consumer', 'foreign-referrer');
        expect(referrer.spec.relations['dependsOn']).toEqual(['ledger']);
        const observer = await getAs(tenantId, 'consumer', 'foreign-observer');
        expect(observer.status?.relations['dependsOn']).toEqual(['ledger']);
      });
    });
  });

  it('a cross-tenant id stays CATALOG_NOT_FOUND', async () => {
    const tenantId = await newTenant();
    await createOwned(tenantId, 'service', 'payments', { team: 'platform' });
    const otherTenant = await newTenant();
    const admin = ctx(otherTenant, 'admin-x', ADMIN);

    const target = { blueprint: 'service', identifier: 'payments' };
    await expectCatalogErrorCode(entities.get(admin, target), 'CATALOG_NOT_FOUND');
    // (`upsert` would create the missing entity, so `writeStatus` stands in for an update.)
    await expectCatalogErrorCode(
      entities.writeStatus(admin, { ...target, observedGeneration: 1, source: 'test' }),
      'CATALOG_NOT_FOUND',
    );
    await expectCatalogErrorCode(entities.delete(admin, target), 'CATALOG_NOT_FOUND');
  });

  it('every entity operation sends ownerTeam, createdBy, locked and the row tenantId to Cerbos', async () => {
    const tenantId = await newTenant();
    const creatorId = `creator-${randomUUID()}`;
    await createOwned(tenantId, 'service', 'attrs', {
      team: 'platform',
      locked: true,
      actorId: creatorId,
    });
    const admin = ctx(tenantId, 'admin-1', ADMIN);
    const target = { blueprint: 'service', identifier: 'attrs' };

    const attrsOf = async (action: string, run: () => Promise<unknown>) => {
      recorded.length = 0;
      await run();
      const match = recorded.filter((entry) => entry.action === action && entry.id === 'attrs');
      expect(match.length, `a ${action} check for the entity`).toBeGreaterThan(0);
      return match[match.length - 1]?.attr ?? {};
    };
    const expected = {
      tenantId,
      blueprintId: 'service',
      ownerTeam: 'platform',
      createdBy: creatorId,
      locked: true,
    };

    expect(await attrsOf('view', () => entities.get(admin, target))).toMatchObject(expected);
    expect(
      await attrsOf('update', () => update(tenantId, admin, 'service', 'attrs')),
    ).toMatchObject(expected);
    expect(
      await attrsOf('update', () =>
        entities.writeStatus(admin, { ...target, observedGeneration: 1, source: 'test' }),
      ),
    ).toMatchObject(expected);
    expect(
      await attrsOf('view', () =>
        entities.listRelated(admin, { ...target, direction: 'forward', scope: 'both' }),
      ),
    ).toMatchObject(expected);
    expect(await attrsOf('delete', () => entities.delete(admin, target))).toMatchObject(expected);

    // For create, the attributes are those of the entity being created.
    recorded.length = 0;
    await entities.create(admin, {
      blueprint: 'service',
      identifier: 'brand-new',
      title: 'brand-new',
      spec: { properties: { locked: false }, relations: { ownerTeam: 'other' } },
    });
    const created = recorded.find((entry) => entry.action === 'create' && entry.id === 'brand-new');
    expect(created?.attr).toMatchObject({
      tenantId,
      blueprintId: 'service',
      ownerTeam: 'other',
      createdBy: 'admin-1',
      locked: false,
    });
  });

  it('an entity with no owner team sends no ownerTeam attribute', async () => {
    const tenantId = await newTenant();
    await createOwned(tenantId, 'service', 'plain');
    recorded.length = 0;
    await entities.get(ctx(tenantId, 'admin-1', ADMIN), {
      blueprint: 'service',
      identifier: 'plain',
    });
    const view = recorded.find((entry) => entry.action === 'view' && entry.id === 'plain');
    expect(view, 'a view check for the entity').toBeDefined();
    expect(Object.hasOwn(view?.attr ?? {}, 'ownerTeam')).toBe(false);
  });
});
