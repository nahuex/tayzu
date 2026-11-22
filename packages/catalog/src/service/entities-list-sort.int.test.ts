/**
 * Integration tests for 003 task 3.4 (openspec/changes/003-catalog-ui-core,
 * design D6, Resolved decision Q37; catalog-core delta spec, requirement
 * "Entity read, list and delete").
 *
 * Runs through the real `createEntityService({ pool, authz }).list`, a real
 * PostgreSQL (under `tayzu_app` and row-level security) and the real Cerbos
 * container on localhost:3593. Every test seeds its own fresh tenant, so the
 * cases are parallel-safe and every assertion is scoped to that tenant.
 *
 * - The order is the sort key, then `identifier`, in the same direction.
 * - The version-2 cursor `{ v: 2, s, o, id }` carries only the anchor row id;
 *   the server reads that row's sort key inside the tenant transaction, under
 *   the same `tenant_id`, blueprint and Cerbos plan filter as the page.
 * - An anchor that is missing, in another blueprint or tenant, or not readable
 *   answers `CATALOG_VALIDATION_FAILED` on `/cursor`, the same answer as a
 *   cursor of another sort or order or a malformed one.
 * - The default order (`identifier` `asc`) and the version-1 `{ k }` cursor
 *   behave as before.
 *
 * Where a caller whose plan limits what it may list is needed, the
 * `planResources` answer is replaced with a conditional plan on
 * `request.resource.attr.createdBy` (the same pattern as
 * `authz-list.int.test.ts` and `entities-list-query-plan.int.test.ts`), since
 * the repository policies yield ALWAYS_ALLOWED for `member` on `list`.
 *
 * Anchor row ids and exact `updated_at` timestamps are read and written
 * through the owner connection, which bypasses RLS; every such statement
 * filters by the test's own `tenant_id`.
 */
import type { CerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authz } from './__fixtures__/authz-test-helpers.js';
import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
} from './__fixtures__/blueprint-test-helpers.js';
import { blueprintInput, ctx, entityInput } from './__fixtures__/entity-a-test-helpers.js';
import type { CatalogError } from '../domain/errors.js';
import {
  encodeCursor,
  encodeSortCursor,
  type EntitySortField,
  type EntitySortOrder,
} from '../domain/pagination.js';
import { createBlueprintService } from './blueprints.js';
import { createEntityService, type EntityService } from './entities.js';

/** spec Conventions, "Default limits": "Pagination cursor | 512 characters". */
const CURSOR_MAX_LENGTH = 512;

/** Guards a paging loop against a cursor that never ends. */
const MAX_PAGES = 50;

const ALL_SORTS: readonly { sort: EntitySortField; order: EntitySortOrder }[] = [
  { sort: 'identifier', order: 'asc' },
  { sort: 'identifier', order: 'desc' },
  { sort: 'title', order: 'asc' },
  { sort: 'title', order: 'desc' },
  { sort: 'updatedAt', order: 'asc' },
  { sort: 'updatedAt', order: 'desc' },
];

/** A duck-typed `PlanResources` result, like `@cerbos/core`'s response. */
type FakePlan = { readonly kind: string; readonly condition?: unknown };

/** The plan a caller who may list only what `userId` created would get. */
const createdByPlan = (userId: string): FakePlan => ({
  kind: 'KIND_CONDITIONAL',
  condition: {
    operator: 'eq',
    operands: [{ name: 'request.resource.attr.createdBy' }, { value: userId }],
  },
});

/** Wraps the real client; `planResources` answers `plan` instead. */
function withPlan(real: CerbosClient, plan: FakePlan): CerbosClient {
  return new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (prop === 'planResources') {
        return () =>
          Promise.resolve({
            cerbosCallId: 'test',
            requestId: 'test',
            validationErrors: [],
            ...plan,
          });
      }
      return method.bind(target);
    },
  });
}

/** A member whose list plan is narrowed to what `user-a` created. */
function memberCtx(tenantId: string): Record<string, unknown> {
  return { tenantId, actor: { type: 'user', id: 'user-a' }, principal: { roles: ['member'] } };
}

interface PageResult {
  readonly identifier: string;
  readonly title: string;
  readonly updatedAt: string;
}

interface PagedList {
  readonly pages: readonly (readonly PageResult[])[];
  readonly cursors: readonly string[];
}

/** Pages through `entities.list` until no cursor is returned. */
async function listAllPages(
  service: EntityService,
  context: unknown,
  input: {
    readonly blueprint: string;
    readonly pageSize?: number;
    readonly sort?: EntitySortField;
    readonly order?: EntitySortOrder;
  },
): Promise<PagedList> {
  const pages: PageResult[][] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const page = await service.list(context, cursor === undefined ? input : { ...input, cursor });
    pages.push(
      page.items.map((item) => ({
        identifier: item.identifier,
        title: item.title,
        updatedAt: item.updatedAt,
      })),
    );
    if (page.cursor === undefined) return { pages, cursors };
    cursors.push(page.cursor);
    cursor = page.cursor;
  }
  throw new Error(`entities.list returned a cursor for more than ${String(MAX_PAGES)} pages`);
}

const identifiersOf = (paged: PagedList): string[] =>
  paged.pages.flat().map((item) => item.identifier);

/** The comparable public shape of a rejection: what the caller can observe. */
function observable(error: CatalogError): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    issues: error.issues,
    details: error.details,
  };
}

/** Asserts `CATALOG_VALIDATION_FAILED` with exactly one issue, on `/cursor`. */
async function expectCursorRejected(promise: Promise<unknown>): Promise<CatalogError> {
  const error = await expectCatalogErrorCode(promise, 'CATALOG_VALIDATION_FAILED');
  expect(error.issues?.map((issue) => issue.path)).toEqual(['/cursor']);
  return error;
}

describe('entities.list sorting (003 task 3.4, design D6, Q37)', () => {
  const url = databaseUrl();
  const pool = connect(url).$client;
  const ownerDb = connectAsOwner(url);
  const blueprints = createBlueprintService({ pool, authz });
  const entities = createEntityService({ pool, authz });
  const restricted = createEntityService({ pool, authz: withPlan(authz, createdByPlan('user-a')) });

  beforeAll(async () => {
    await runMigrations(ownerDb.$client);
  });

  afterAll(async () => {
    await endQuietly(pool);
    await endQuietly(ownerDb.$client);
  });

  interface SeedRow {
    readonly identifier: string;
    readonly title?: string;
    /** The exact `updated_at`, written through the owner connection after creation. */
    readonly updatedAt?: string;
    /** The creating actor's id (the plan maps `createdBy` to it). */
    readonly createdBy?: string;
  }

  /** Creates `blueprint` (once) and its entities in `tenantId` through the real services. */
  async function seed(tenantId: string, blueprint: string, rows: readonly SeedRow[]) {
    await blueprints.create(ctx(tenantId), blueprintInput(blueprint));
    for (const row of rows) {
      await entities.create(
        ctx(tenantId, { type: 'user', id: row.createdBy ?? 'user-1' }),
        entityInput(blueprint, row.identifier, { title: row.title ?? row.identifier }),
      );
      if (row.updatedAt !== undefined) {
        await setUpdatedAt(tenantId, blueprint, row.identifier, row.updatedAt);
      }
    }
  }

  /** Sets one entity's stored `updated_at` to an exact timestamp, within `tenantId`. */
  async function setUpdatedAt(
    tenantId: string,
    blueprint: string,
    identifier: string,
    iso: string,
  ): Promise<void> {
    const result = await ownerDb.execute(sql`
      update catalog_entity e
      set updated_at = ${iso}::timestamptz
      from catalog_blueprint b
      where e.tenant_id = ${tenantId}
        and b.tenant_id = ${tenantId}
        and b.id = e.blueprint_id
        and b.identifier = ${blueprint}
        and e.identifier = ${identifier}
    `);
    if (result.rowCount !== 1) {
      throw new Error(`setUpdatedAt: expected one row for ${blueprint}/${identifier}`);
    }
  }

  /** The internal `catalog_entity.id` of one entity, within `tenantId`. */
  async function entityRowId(
    tenantId: string,
    blueprint: string,
    identifier: string,
  ): Promise<string> {
    const result = await ownerDb.execute<{ id: string }>(sql`
      select e.id
      from catalog_entity e
      join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
      where e.tenant_id = ${tenantId} and b.identifier = ${blueprint} and e.identifier = ${identifier}
    `);
    const row = result.rows[0];
    if (!row) throw new Error(`entityRowId: no row for ${blueprint}/${identifier}`);
    return row.id;
  }

  describe('List sorted by title descending pages without gaps', () => {
    it('List sorted by title descending pages without gaps: Alpha, Beta, Beta, Gamma at page size 2', async () => {
      const tenantId = randomTenantId();
      // GIVEN blueprint `service` has entities titled Alpha, Beta, Beta and Gamma.
      await seed(tenantId, 'service', [
        { identifier: 'alpha', title: 'Alpha' },
        { identifier: 'beta1', title: 'Beta' },
        { identifier: 'beta2', title: 'Beta' },
        { identifier: 'gamma', title: 'Gamma' },
      ]);

      // WHEN they are listed sorted by `title` in `desc` order with a page size of 2 ...
      const first = await entities.list(ctx(tenantId), {
        blueprint: 'service',
        sort: 'title',
        order: 'desc',
        pageSize: 2,
      });
      // THEN the first page holds Gamma and one Beta.
      expect(first.items.map((item) => item.title)).toEqual(['Gamma', 'Beta']);
      expect(first.cursor).toBeDefined();

      // ... AND the next page is requested with the returned cursor.
      const second = await entities.list(ctx(tenantId), {
        blueprint: 'service',
        sort: 'title',
        order: 'desc',
        pageSize: 2,
        cursor: first.cursor,
      });
      // THEN the second page holds the other Beta and Alpha.
      expect(second.items.map((item) => item.title)).toEqual(['Beta', 'Alpha']);
      expect(second.cursor).toBeUndefined();

      // AND the two Beta rows are ordered by identifier (in the same, descending, direction).
      expect([...first.items, ...second.items].map((item) => item.identifier)).toEqual([
        'gamma',
        'beta2',
        'beta1',
        'alpha',
      ]);
    });

    it('List sorted by title descending pages without gaps: every row exactly once, ties ordered by identifier, at page sizes 1, 2 and 3', async () => {
      const tenantId = randomTenantId();
      // Identifier order deliberately differs from title order.
      await seed(tenantId, 'service', [
        { identifier: 'e01', title: 'Zeta' },
        { identifier: 'e02', title: 'Beta' },
        { identifier: 'e03', title: 'Gamma' },
        { identifier: 'e04', title: 'Beta' },
        { identifier: 'e05', title: 'Alpha' },
        { identifier: 'e06', title: 'Omega' },
        { identifier: 'e07', title: 'Gamma' },
        { identifier: 'e08', title: 'Beta' },
        { identifier: 'e09', title: 'Delta' },
      ]);
      // title desc, then identifier desc.
      const expectedDesc = ['e01', 'e06', 'e07', 'e03', 'e09', 'e08', 'e04', 'e02', 'e05'];

      for (const pageSize of [1, 2, 3]) {
        const paged = await listAllPages(entities, ctx(tenantId), {
          blueprint: 'service',
          sort: 'title',
          order: 'desc',
          pageSize,
        });
        // No gaps, no duplicates, the exact order.
        expect(identifiersOf(paged)).toEqual(expectedDesc);
        for (const page of paged.pages) expect(page.length).toBeLessThanOrEqual(pageSize);
        for (const cursor of paged.cursors) {
          expect(cursor.length).toBeLessThanOrEqual(CURSOR_MAX_LENGTH);
        }
      }

      // title asc, then identifier asc: the exact reverse.
      const ascending = await listAllPages(entities, ctx(tenantId), {
        blueprint: 'service',
        sort: 'title',
        order: 'asc',
        pageSize: 2,
      });
      expect(identifiersOf(ascending)).toEqual([...expectedDesc].reverse());
    });
  });

  describe('Sort by update time', () => {
    it('Sort by update time: `a` updated after `b` comes first in desc order, and two rows in the same millisecond are ordered by identifier', async () => {
      const tenantId = randomTenantId();
      // GIVEN entity `a` was updated after entity `b`; `c` and `d` share one millisecond in between.
      // Identifier order (a < b) is the opposite of the expected time order, so
      // only `updated_at` can put `a` first.
      await seed(tenantId, 'service', [
        { identifier: 'a', updatedAt: '2026-03-01T10:00:03.000Z' },
        { identifier: 'b', updatedAt: '2026-03-01T10:00:01.000Z' },
        { identifier: 'c', updatedAt: '2026-03-01T10:00:02.000Z' },
        { identifier: 'd', updatedAt: '2026-03-01T10:00:02.000Z' },
      ]);

      // WHEN the entities are listed sorted by `updatedAt` in `desc` order.
      const desc = await entities.list(ctx(tenantId), {
        blueprint: 'service',
        sort: 'updatedAt',
        order: 'desc',
      });
      // THEN `a` comes before `b`; the same-millisecond pair is ordered by identifier desc.
      expect(desc.items.map((item) => item.identifier)).toEqual(['a', 'd', 'c', 'b']);
      expect(desc.items.map((item) => item.updatedAt)).toEqual([
        '2026-03-01T10:00:03.000Z',
        '2026-03-01T10:00:02.000Z',
        '2026-03-01T10:00:02.000Z',
        '2026-03-01T10:00:01.000Z',
      ]);
      expect(desc.cursor).toBeUndefined();

      const asc = await entities.list(ctx(tenantId), {
        blueprint: 'service',
        sort: 'updatedAt',
        order: 'asc',
      });
      expect(asc.items.map((item) => item.identifier)).toEqual(['b', 'c', 'd', 'a']);
    });

    it('Sort by update time: paging splits the same-millisecond pair across pages without a gap or a duplicate', async () => {
      const tenantId = randomTenantId();
      await seed(tenantId, 'service', [
        { identifier: 'a', updatedAt: '2026-03-01T10:00:03.000Z' },
        { identifier: 'b', updatedAt: '2026-03-01T10:00:01.000Z' },
        { identifier: 'c', updatedAt: '2026-03-01T10:00:02.000Z' },
        { identifier: 'd', updatedAt: '2026-03-01T10:00:02.000Z' },
        { identifier: 'e', updatedAt: '2026-03-01T10:00:02.000Z' },
      ]);

      for (const pageSize of [1, 2]) {
        const desc = await listAllPages(entities, ctx(tenantId), {
          blueprint: 'service',
          sort: 'updatedAt',
          order: 'desc',
          pageSize,
        });
        expect(identifiersOf(desc)).toEqual(['a', 'e', 'd', 'c', 'b']);

        const asc = await listAllPages(entities, ctx(tenantId), {
          blueprint: 'service',
          sort: 'updatedAt',
          order: 'asc',
          pageSize,
        });
        expect(identifiersOf(asc)).toEqual(['b', 'c', 'd', 'e', 'a']);
      }
    });
  });

  describe('A cursor of another sort is rejected', () => {
    it('A cursor of another sort is rejected: a `title` cursor sent with `identifier` fails with CATALOG_VALIDATION_FAILED on /cursor', async () => {
      const tenantId = randomTenantId();
      await seed(tenantId, 'service', [
        { identifier: 'a', title: 'Gamma' },
        { identifier: 'b', title: 'Beta' },
        { identifier: 'c', title: 'Alpha' },
      ]);

      // GIVEN a cursor returned by a list sorted by `title`.
      const titled = await entities.list(ctx(tenantId), {
        blueprint: 'service',
        sort: 'title',
        order: 'asc',
        pageSize: 1,
      });
      const titleCursor = titled.cursor;
      expect(titleCursor).toBeDefined();
      if (titleCursor === undefined) return;

      // WHEN it is sent with a list sorted by `identifier`,
      // THEN the list fails with CATALOG_VALIDATION_FAILED on /cursor.
      await expectCursorRejected(
        entities.list(ctx(tenantId), {
          blueprint: 'service',
          sort: 'identifier',
          pageSize: 1,
          cursor: titleCursor,
        }),
      );
      // The default sort (no `sort`, no `order`) is `identifier` `asc`: the same answer.
      await expectCursorRejected(
        entities.list(ctx(tenantId), { blueprint: 'service', pageSize: 1, cursor: titleCursor }),
      );
      // Another sort key, and the same key in the other order, answer the same.
      await expectCursorRejected(
        entities.list(ctx(tenantId), {
          blueprint: 'service',
          sort: 'updatedAt',
          order: 'asc',
          pageSize: 1,
          cursor: titleCursor,
        }),
      );
      await expectCursorRejected(
        entities.list(ctx(tenantId), {
          blueprint: 'service',
          sort: 'title',
          order: 'desc',
          pageSize: 1,
          cursor: titleCursor,
        }),
      );
    });

    it('A cursor of another sort is rejected: a default-sort cursor, or a version-1 cursor, sent with `title` fails on /cursor', async () => {
      const tenantId = randomTenantId();
      await seed(tenantId, 'service', [
        { identifier: 'a', title: 'Gamma' },
        { identifier: 'b', title: 'Beta' },
        { identifier: 'c', title: 'Alpha' },
      ]);

      const byIdentifier = await entities.list(ctx(tenantId), {
        blueprint: 'service',
        pageSize: 1,
      });
      const defaultCursor = byIdentifier.cursor;
      expect(defaultCursor).toBeDefined();
      if (defaultCursor === undefined) return;

      for (const cursor of [defaultCursor, encodeCursor('a')]) {
        await expectCursorRejected(
          entities.list(ctx(tenantId), {
            blueprint: 'service',
            sort: 'title',
            order: 'asc',
            pageSize: 1,
            cursor,
          }),
        );
        await expectCursorRejected(
          entities.list(ctx(tenantId), {
            blueprint: 'service',
            sort: 'identifier',
            order: 'desc',
            pageSize: 1,
            cursor,
          }),
        );
      }
    });
  });

  describe('Long titles and identifiers still page', () => {
    it('Long titles and identifiers still page: 256-character titles and identifiers, every cursor at most 512 characters and the second page continues the order', async () => {
      const tenantId = randomTenantId();
      const longIdentifier = (ch: string): string => ch.repeat(256);
      const longTitle = (ch: string): string => `${'P'.repeat(255)}${ch}`;
      // GIVEN entities with 256-character titles and 256-character identifiers.
      // Title order differs from identifier order, with one tie on title.
      const rows: SeedRow[] = [
        { identifier: longIdentifier('a'), title: longTitle('e') },
        { identifier: longIdentifier('b'), title: longTitle('c') },
        { identifier: longIdentifier('c'), title: longTitle('c') },
        { identifier: longIdentifier('d'), title: longTitle('b') },
        { identifier: longIdentifier('e'), title: longTitle('a') },
      ];
      for (const row of rows) {
        expect(row.identifier).toHaveLength(256);
        expect(row.title).toHaveLength(256);
      }
      await seed(tenantId, 'service', rows);

      // title asc, then identifier asc.
      const expectedAsc = ['e', 'd', 'b', 'c', 'a'].map(longIdentifier);

      // WHEN they are listed sorted by `title` and the next page is requested.
      const first = await entities.list(ctx(tenantId), {
        blueprint: 'service',
        sort: 'title',
        pageSize: 2,
      });
      expect(first.cursor).toBeDefined();
      const second = await entities.list(ctx(tenantId), {
        blueprint: 'service',
        sort: 'title',
        pageSize: 2,
        cursor: first.cursor,
      });
      // THEN every returned cursor is at most 512 characters ...
      for (const cursor of [first.cursor, second.cursor]) {
        if (cursor !== undefined) expect(cursor.length).toBeLessThanOrEqual(CURSOR_MAX_LENGTH);
      }
      // ... AND the second page continues the order.
      expect([...first.items, ...second.items].map((item) => item.identifier)).toEqual(
        expectedAsc.slice(0, 4),
      );

      // Every page, in both directions, at page size 1 (the longest cursor chain).
      for (const order of ['asc', 'desc'] as const) {
        const paged = await listAllPages(entities, ctx(tenantId), {
          blueprint: 'service',
          sort: 'title',
          order,
          pageSize: 1,
        });
        expect(identifiersOf(paged)).toEqual(
          order === 'asc' ? expectedAsc : [...expectedAsc].reverse(),
        );
        expect(paged.cursors).toHaveLength(rows.length - 1);
        for (const cursor of paged.cursors) {
          expect(cursor.length).toBeLessThanOrEqual(CURSOR_MAX_LENGTH);
        }
      }
    });
  });

  describe('A cursor anchored on an unreadable entity is rejected', () => {
    /**
     * Tenant with blueprint `service`: `mine-1`, `mine-2`, `mine-3` created by
     * `user-a` (readable under the restricted plan) and `hidden-1`,
     * `hidden-2` created by `user-b` (not readable), plus blueprint
     * `component` with `mine-other` created by `user-a`.
     */
    async function seedAnchors(tenantId: string): Promise<void> {
      await seed(tenantId, 'service', [
        { identifier: 'mine-1', title: 'Alpha', createdBy: 'user-a' },
        { identifier: 'hidden-1', title: 'Bravo secret', createdBy: 'user-b' },
        { identifier: 'mine-2', title: 'Charlie', createdBy: 'user-a' },
        { identifier: 'hidden-2', title: 'Delta secret', createdBy: 'user-b' },
        { identifier: 'mine-3', title: 'Echo', createdBy: 'user-a' },
      ]);
      await seed(tenantId, 'component', [
        { identifier: 'mine-other', title: 'Foxtrot', createdBy: 'user-a' },
      ]);
    }

    const titleAsc = (id: string): string => encodeSortCursor({ sort: 'title', order: 'asc', id });

    it('A cursor anchored on an unreadable entity is rejected: CATALOG_VALIDATION_FAILED on /cursor, revealing nothing about that entity', async () => {
      const tenantId = randomTenantId();
      await seedAnchors(tenantId);

      // GIVEN a cursor crafted to point at an entity the caller cannot read.
      const hiddenId = await entityRowId(tenantId, 'service', 'hidden-1');
      const crafted = titleAsc(hiddenId);

      // WHEN it is sent with a list sorted by `title`,
      // THEN the list fails with CATALOG_VALIDATION_FAILED on /cursor ...
      const unreadable = await expectCursorRejected(
        restricted.list(memberCtx(tenantId), {
          blueprint: 'service',
          sort: 'title',
          order: 'asc',
          cursor: crafted,
        }),
      );

      // ... AND reveals nothing about that entity: the answer is the same as
      // for an anchor that does not exist at all, and as for a malformed cursor.
      const missing = await expectCursorRejected(
        restricted.list(memberCtx(tenantId), {
          blueprint: 'service',
          sort: 'title',
          order: 'asc',
          cursor: titleAsc('00000000-0000-7000-8000-000000000000'),
        }),
      );
      const malformed = await expectCursorRejected(
        restricted.list(memberCtx(tenantId), {
          blueprint: 'service',
          sort: 'title',
          order: 'asc',
          cursor: 'not-a-cursor',
        }),
      );
      expect(observable(unreadable)).toEqual(observable(missing));
      expect(observable(unreadable)).toEqual(observable(malformed));
      const exposed = JSON.stringify({ ...observable(unreadable), stack: unreadable.stack });
      expect(exposed).not.toContain('hidden-1');
      expect(exposed).not.toContain('Bravo secret');

      // The readable anchor next to it does page (the plan, not the cursor, is what failed).
      const mineId = await entityRowId(tenantId, 'service', 'mine-1');
      const next = await restricted.list(memberCtx(tenantId), {
        blueprint: 'service',
        sort: 'title',
        order: 'asc',
        cursor: titleAsc(mineId),
      });
      expect(next.items.map((item) => item.identifier)).toEqual(['mine-2', 'mine-3']);
    });

    it('A cursor anchored on an unreadable entity is rejected: an anchor in another tenant answers exactly the same', async () => {
      const tenantId = randomTenantId();
      const otherTenantId = randomTenantId();
      await seedAnchors(tenantId);
      // The same blueprint and identifier in another tenant, created by the same user id.
      await seed(otherTenantId, 'service', [
        { identifier: 'mine-1', title: 'Alpha', createdBy: 'user-a' },
        { identifier: 'foreign-1', title: 'Golf foreign', createdBy: 'user-a' },
      ]);

      const missing = await expectCursorRejected(
        restricted.list(memberCtx(tenantId), {
          blueprint: 'service',
          sort: 'title',
          order: 'asc',
          cursor: titleAsc('00000000-0000-7000-8000-000000000000'),
        }),
      );

      for (const identifier of ['mine-1', 'foreign-1']) {
        const foreignId = await entityRowId(otherTenantId, 'service', identifier);
        // Through the restricted plan and through the admin's unrestricted one.
        for (const [service, context] of [
          [restricted, memberCtx(tenantId)],
          [entities, ctx(tenantId)],
        ] as const) {
          const crossTenant = await expectCursorRejected(
            service.list(context, {
              blueprint: 'service',
              sort: 'title',
              order: 'asc',
              cursor: titleAsc(foreignId),
            }),
          );
          expect(observable(crossTenant)).toEqual(observable(missing));
          expect(JSON.stringify(observable(crossTenant))).not.toContain('Golf foreign');
        }
      }
    });

    it('A cursor anchored on an unreadable entity is rejected: an anchor in another blueprint, or deleted meanwhile, answers the same', async () => {
      const tenantId = randomTenantId();
      await seedAnchors(tenantId);

      const missing = await expectCursorRejected(
        entities.list(ctx(tenantId), {
          blueprint: 'service',
          sort: 'title',
          order: 'asc',
          cursor: titleAsc('00000000-0000-7000-8000-000000000000'),
        }),
      );

      // Another blueprint of the same tenant, readable by both callers.
      const otherBlueprintId = await entityRowId(tenantId, 'component', 'mine-other');
      for (const [service, context] of [
        [restricted, memberCtx(tenantId)],
        [entities, ctx(tenantId)],
      ] as const) {
        const otherBlueprint = await expectCursorRejected(
          service.list(context, {
            blueprint: 'service',
            sort: 'title',
            order: 'asc',
            cursor: titleAsc(otherBlueprintId),
          }),
        );
        expect(observable(otherBlueprint)).toEqual(observable(missing));
      }

      // An anchor deleted between two page requests.
      const first = await entities.list(ctx(tenantId), {
        blueprint: 'service',
        sort: 'title',
        order: 'desc',
        pageSize: 2,
      });
      const lastOfFirst = first.items[first.items.length - 1];
      expect(lastOfFirst?.identifier).toBe('hidden-2');
      expect(first.cursor).toBeDefined();
      await entities.delete(ctx(tenantId), { blueprint: 'service', identifier: 'hidden-2' });
      const deleted = await expectCursorRejected(
        entities.list(ctx(tenantId), {
          blueprint: 'service',
          sort: 'title',
          order: 'desc',
          pageSize: 2,
          cursor: first.cursor,
        }),
      );
      expect(observable(deleted)).toEqual(observable(missing));
    });
  });

  describe('Sorting does not widen visibility', () => {
    it('Sorting does not widen visibility: a member who can read 3 of the 5 entities sees exactly those 3 under every sort', async () => {
      const tenantId = randomTenantId();
      // GIVEN a member who can read 3 of the 5 entities of a blueprint.
      // Title and time orders interleave the readable and the unreadable rows.
      await seed(tenantId, 'service', [
        {
          identifier: 'v1',
          title: 'Echo',
          createdBy: 'user-a',
          updatedAt: '2026-03-01T10:00:02.000Z',
        },
        {
          identifier: 'v2',
          title: 'Alpha',
          createdBy: 'user-b',
          updatedAt: '2026-03-01T10:00:05.000Z',
        },
        {
          identifier: 'v3',
          title: 'Charlie',
          createdBy: 'user-a',
          updatedAt: '2026-03-01T10:00:04.000Z',
        },
        {
          identifier: 'v4',
          title: 'Delta',
          createdBy: 'user-b',
          updatedAt: '2026-03-01T10:00:01.000Z',
        },
        {
          identifier: 'v5',
          title: 'Bravo',
          createdBy: 'user-a',
          updatedAt: '2026-03-01T10:00:03.000Z',
        },
      ]);
      const visibleAsc: Record<EntitySortField, string[]> = {
        identifier: ['v1', 'v3', 'v5'],
        title: ['v5', 'v3', 'v1'],
        updatedAt: ['v1', 'v5', 'v3'],
      };

      // WHEN the member lists them sorted by `updatedAt`,
      // THEN exactly those 3 are returned.
      const byTime = await restricted.list(memberCtx(tenantId), {
        blueprint: 'service',
        sort: 'updatedAt',
        order: 'desc',
      });
      expect(byTime.items.map((item) => item.identifier)).toEqual(['v3', 'v5', 'v1']);
      expect(byTime.cursor).toBeUndefined();

      // And the same set under every sort, order and page size, never more.
      for (const { sort, order } of ALL_SORTS) {
        for (const pageSize of [1, 2, 50]) {
          const paged = await listAllPages(restricted, memberCtx(tenantId), {
            blueprint: 'service',
            sort,
            order,
            pageSize,
          });
          const expected = order === 'asc' ? visibleAsc[sort] : [...visibleAsc[sort]].reverse();
          expect(identifiersOf(paged), `${sort} ${order} page size ${String(pageSize)}`).toEqual(
            expected,
          );
        }
      }

      // The unrestricted admin sees all 5 under the same sort (the plan is what narrows).
      const admin = await entities.list(ctx(tenantId), {
        blueprint: 'service',
        sort: 'updatedAt',
        order: 'desc',
      });
      expect(admin.items.map((item) => item.identifier)).toEqual(['v2', 'v3', 'v5', 'v1', 'v4']);
    });
  });

  describe('The default order is unchanged', () => {
    it('The default order is unchanged: no sort and `identifier` `asc` list by identifier ascending and page with the returned cursor', async () => {
      const tenantId = randomTenantId();
      await seed(tenantId, 'service', [
        { identifier: 'c', title: 'Alpha' },
        { identifier: 'a', title: 'Gamma' },
        { identifier: 'e', title: 'Beta' },
        { identifier: 'b', title: 'Delta' },
        { identifier: 'd', title: 'Alpha' },
      ]);
      const expected = ['a', 'b', 'c', 'd', 'e'];

      const unsorted = await entities.list(ctx(tenantId), { blueprint: 'service' });
      expect(unsorted.items.map((item) => item.identifier)).toEqual(expected);
      expect(unsorted.cursor).toBeUndefined();

      for (const input of [
        { blueprint: 'service' },
        { blueprint: 'service', sort: 'identifier' as const },
        { blueprint: 'service', order: 'asc' as const },
        { blueprint: 'service', sort: 'identifier' as const, order: 'asc' as const },
      ]) {
        for (const pageSize of [1, 2]) {
          const paged = await listAllPages(entities, ctx(tenantId), { ...input, pageSize });
          expect(identifiersOf(paged)).toEqual(expected);
        }
      }

      // A cursor issued without a sort continues an explicit `identifier` `asc` list, and back.
      const first = await entities.list(ctx(tenantId), { blueprint: 'service', pageSize: 2 });
      const explicit = await entities.list(ctx(tenantId), {
        blueprint: 'service',
        sort: 'identifier',
        order: 'asc',
        pageSize: 2,
        cursor: first.cursor,
      });
      expect(explicit.items.map((item) => item.identifier)).toEqual(['c', 'd']);
      const back = await entities.list(ctx(tenantId), {
        blueprint: 'service',
        pageSize: 2,
        cursor: explicit.cursor,
      });
      expect(back.items.map((item) => item.identifier)).toEqual(['e']);
      expect(back.cursor).toBeUndefined();
    });

    it('The default order is unchanged: a version-1 cursor issued before sorting existed stays valid for the default sort', async () => {
      const tenantId = randomTenantId();
      await seed(tenantId, 'service', [
        { identifier: 'a' },
        { identifier: 'b' },
        { identifier: 'c' },
        { identifier: 'd' },
      ]);

      for (const input of [
        { blueprint: 'service' },
        { blueprint: 'service', sort: 'identifier' as const, order: 'asc' as const },
      ]) {
        const page = await entities.list(ctx(tenantId), {
          ...input,
          pageSize: 2,
          cursor: encodeCursor('a'),
        });
        expect(page.items.map((item) => item.identifier)).toEqual(['b', 'c']);
        expect(page.cursor).toBeDefined();

        const rest = await entities.list(ctx(tenantId), {
          ...input,
          pageSize: 2,
          cursor: page.cursor,
        });
        expect(rest.items.map((item) => item.identifier)).toEqual(['d']);
        expect(rest.cursor).toBeUndefined();

        // A version-1 key that no longer exists still bounds the keyset, as before.
        const between = await entities.list(ctx(tenantId), {
          ...input,
          cursor: encodeCursor('bb'),
        });
        expect(between.items.map((item) => item.identifier)).toEqual(['c', 'd']);
      }
    });
  });
});
