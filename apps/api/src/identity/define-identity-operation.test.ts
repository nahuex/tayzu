/**
 * Task 5.3b of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (spec
 * requirement "Every identity route declares its authorization"; design D10,
 * Resolved decisions Q45 and Q57).
 *
 * Verify clause: "`define-identity-operation.test.ts` covers a denial never
 * running the handler and the attributes carrying the target's tenant".
 *
 * Cases:
 *
 * - a denial at the caller-tenant check never runs the handler and never
 *   resolves the target;
 * - a denial at the target check (the caller-tenant check allowed) never runs
 *   the handler;
 * - the attributes of the target check carry the **target's** tenant (the one
 *   the resolver returned), the first check the caller's own tenant;
 * - an allowed call runs the handler once, with the resolved target.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/define-operation.ts
 * export interface IdentityOperationDeps {
 *   readonly authz: CerbosClient;                // @tayzu/authz
 *   readonly targetResolver: IdentityTargetResolver; // ./identity-target.js (5.2)
 * }
 * export function createDefineIdentityOperation(deps: IdentityOperationDeps): DefineIdentityOperation;
 * // defineIdentityOperation({ authorization: { kind, action, resolveTarget }, handler })
 * //   kind: ResourceKind; action: string;
 * //   resolveTarget(input): { kind: IdentityTargetKind; id: string } | undefined
 * //     (undefined for an operation with no target: only the caller-tenant check runs)
 * //   handler({ context, input, target }): Promise<unknown>, `target` being the
 * //     ResolvedIdentityTarget (or undefined)
 * // Returns an oRPC procedure (usable in createRouterClient) carrying the brand.
 * export function isIdentityOperation(procedure: unknown): boolean;
 * ```
 *
 * A denial throws an `Error` whose `code` is `AUTH_FORBIDDEN`.
 */
// Load-bearing import order (design D1): the telemetry harness registers before @tayzu/auth loads.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { RESOURCE_KINDS, type CerbosClient } from '@tayzu/authz';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefineIdentityOperation } from './define-operation.js';
import type { IdentityTargetResolver } from './identity-target.js';

interface RecordedCheck {
  readonly principal: { id: string; roles: string[]; attr: Record<string, unknown> };
  readonly resource: { kind: string; id: string; attr: Record<string, unknown> };
  readonly actions: string[];
}

/** A Cerbos fake that records every check; `decide` is given the 0-based call index. */
function fakeCerbos(decide: (index: number) => boolean) {
  const checks: RecordedCheck[] = [];
  const client = {
    checkResources: vi.fn(
      (request: {
        principal: RecordedCheck['principal'];
        resources: { resource: RecordedCheck['resource']; actions: string[] }[];
      }) => {
        const index = checks.length;
        const entry = request.resources[0];
        if (entry === undefined) throw new Error('no resource in the check');
        checks.push({
          principal: request.principal,
          resource: entry.resource,
          actions: entry.actions,
        });
        const allowed = decide(index);
        return Promise.resolve({ results: [{ isAllowed: () => allowed }] });
      },
    ),
  };
  return { checks, client: client as unknown as CerbosClient };
}

const CALLER_TENANT = 'tenant-caller';
const TARGET_TENANT = 'tenant-target';

function setup(decide: (index: number) => boolean) {
  const { checks, client } = fakeCerbos(decide);
  const resolve = vi.fn((_context: { tenantId: string }, raw: unknown) => {
    const { kind, id } = raw as { kind: 'user'; id: string };
    return Promise.resolve({ kind, id, tenantId: TARGET_TENANT });
  });
  const targetResolver = { resolve } as unknown as IdentityTargetResolver;
  const define = createDefineIdentityOperation({ authz: client, targetResolver });
  const handler = vi.fn(() => Promise.resolve('ran'));
  const op = define({
    authorization: {
      kind: RESOURCE_KINDS.user,
      action: 'update',
      resolveTarget: (input: unknown) => ({
        kind: 'user' as const,
        id: (input as { id: string }).id,
      }),
    },
    handler,
  });
  const router = { op };
  const client2 = createRouterClient(router, {
    context: (raw: Record<string, unknown>) => raw,
  }) as unknown as {
    op(input: unknown, options: { context: Record<string, unknown> }): Promise<unknown>;
  };
  const context: Record<string, unknown> = {
    tenantId: CALLER_TENANT,
    actor: { type: 'user', id: 'actor-1' },
    principal: { roles: ['admin'] },
  };
  return { checks, resolve, handler, call: () => client2.op({ id: 'target-1' }, { context }) };
}

describe('defineIdentityOperation (task 5.3b)', () => {
  it('A denial at the caller-tenant check never runs the handler and never resolves the target', async () => {
    const { checks, resolve, handler, call } = setup(() => false);

    await expect(call()).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    expect(handler).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(checks.length).toBeGreaterThanOrEqual(1);
  });

  it('A denial at the target check never runs the handler', async () => {
    // Allow the first check, deny every later one.
    const { checks, resolve, handler, call } = setup((index) => index === 0);

    await expect(call()).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(checks).toHaveLength(2);
    expect(handler).not.toHaveBeenCalled();
  });

  it("The attributes carry the target's real tenant, not the caller's echoed back", async () => {
    const { checks, handler, call } = setup(() => true);

    await expect(call()).resolves.toBe('ran');

    expect(checks).toHaveLength(2);
    const [first, second] = checks;
    // First check: the caller's role in the caller's own tenant, no target.
    expect(first?.resource.attr['tenantId']).toBe(CALLER_TENANT);
    // Second check: the resolved target, with the tenant the resolver returned.
    expect(second?.resource.attr['tenantId']).toBe(TARGET_TENANT);
    expect(second?.resource.id).toBe('target-1');
    expect(second?.resource.kind).toBe(RESOURCE_KINDS.user);
    expect(second?.actions).toEqual(['update']);
    // The principal stays in the caller's tenant on both checks.
    expect(first?.principal.attr['tenantId']).toBe(CALLER_TENANT);
    expect(second?.principal.attr['tenantId']).toBe(CALLER_TENANT);
    expect(second?.principal.roles).toEqual(['admin']);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('An allowed call hands the resolved target to the handler', async () => {
    const { handler, call } = setup(() => true);

    await call();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ id: 'target-1', tenantId: TARGET_TENANT }) as unknown,
      }),
    );
  });
});

/**
 * Task 10.2 of `044-password-reset-and-account-recovery` (design D10, Cerbos paragraph).
 *
 * Scenario "Self-target is refused" (wrapper level): GIVEN an admin calls `resetMfa` for their
 * own account, THEN it is refused (`AUTH_FORBIDDEN`) and `catalog.security.self_mfa_reset_denied`
 * is logged with the tenant and the admin's id. The `updateStatus` signal stays as it was.
 * Case "the targetless caller check carries no `memberRole`"; the target check carries the raw
 * `memberRole` string the resolver reported, a composite value unmodified.
 *
 * ## Production symbols expected
 *
 * - `ResolvedIdentityTarget.attributes.memberRole?: string` (`identity-target.ts`);
 * - `IdentityResourceInput.memberRole?: string` and operation `'users.resetMfa'`
 *   (`identity-attributes.ts`);
 * - `define-operation.ts` passes `target.attributes.memberRole` to the target check and logs
 *   `catalog.security.self_mfa_reset_denied` (WARN, `tayzu.tenant.id`, `tayzu.actor.id`) when a
 *   `resetMfa` target check is denied and the target id is the actor id.
 */
describe('defineIdentityOperation resetMfa (task 10.2)', () => {
  let harness: TelemetryTestHarness;

  beforeAll(() => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
  });

  beforeEach(async () => {
    await harness.reset();
  });

  async function events(name: string) {
    await harness.forceFlush();
    return harness.logExporter
      .getFinishedLogRecords()
      .filter((record) => record.eventName === name);
  }

  function setupAction(
    action: string,
    decide: (index: number) => boolean,
    targetAttributes?: Record<string, unknown>,
  ) {
    const { checks, client } = fakeCerbos(decide);
    const targetResolver = {
      resolve: (_context: { tenantId: string }, raw: unknown) => {
        const { kind, id } = raw as { kind: 'user'; id: string };
        return Promise.resolve({
          kind,
          id,
          tenantId: CALLER_TENANT,
          ...(targetAttributes === undefined ? {} : { attributes: targetAttributes }),
        });
      },
    } as unknown as IdentityTargetResolver;
    const define = createDefineIdentityOperation({ authz: client, targetResolver });
    const handler = vi.fn(() => Promise.resolve('ran'));
    const op = define({
      authorization: {
        kind: RESOURCE_KINDS.user,
        action,
        resolveTarget: (input: unknown) => ({
          kind: 'user' as const,
          id: (input as { id: string }).id,
        }),
      },
      handler,
    });
    const router = createRouterClient(
      { op },
      { context: (raw: Record<string, unknown>) => raw },
    ) as unknown as {
      op(input: unknown, options: { context: Record<string, unknown> }): Promise<unknown>;
    };
    const actorId = `actor-${randomUUID()}`;
    const context: Record<string, unknown> = {
      tenantId: CALLER_TENANT,
      actor: { type: 'user', id: actorId },
      principal: { roles: ['admin'] },
    };
    return {
      checks,
      handler,
      actorId,
      call: (targetId: string) => router.op({ id: targetId }, { context }),
    };
  }

  it('Self-target is refused: AUTH_FORBIDDEN, no handler, and self_mfa_reset_denied with the tenant and the actor id', async () => {
    const { handler, actorId, call } = setupAction('resetMfa', (index) => index === 0, {
      memberRole: 'admin',
    });

    await expect(call(actorId)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    expect(handler).not.toHaveBeenCalled();
    const denied = await events('catalog.security.self_mfa_reset_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.attributes).toMatchObject({
      'tayzu.tenant.id': CALLER_TENANT,
      'tayzu.actor.id': actorId,
    });
    expect(await events('catalog.security.self_status_change_denied')).toHaveLength(0);
  });

  it('a resetMfa denial for another target logs no self_mfa_reset_denied', async () => {
    const { handler, call } = setupAction('resetMfa', (index) => index === 0, {
      memberRole: 'admin',
    });

    await expect(call(`target-${randomUUID()}`)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    expect(handler).not.toHaveBeenCalled();
    expect(await events('catalog.security.self_mfa_reset_denied')).toHaveLength(0);
  });

  it('the existing updateStatus self-target signal is unchanged and does not log the MFA event', async () => {
    const { actorId, call } = setupAction('updateStatus', (index) => index === 0);

    await expect(call(actorId)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    const denied = await events('catalog.security.self_status_change_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.attributes).toMatchObject({
      'tayzu.tenant.id': CALLER_TENANT,
      'tayzu.actor.id': actorId,
    });
    expect(await events('catalog.security.self_mfa_reset_denied')).toHaveLength(0);
  });

  it('the target check carries the resolver memberRole unmodified, a composite value included', async () => {
    for (const role of ['member', 'admin,owner', 'member,admin']) {
      const { checks, handler, call } = setupAction('resetMfa', () => true, { memberRole: role });

      await expect(call(`target-${randomUUID()}`)).resolves.toBe('ran');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(checks).toHaveLength(2);
      expect(checks[1]?.resource.attr['memberRole']).toBe(role);
    }
  });

  it('the targetless caller check carries no memberRole and names the resource id new', async () => {
    const { checks, call } = setupAction('resetMfa', () => true, { memberRole: 'member' });

    await call(`target-${randomUUID()}`);

    expect(checks[0]?.resource.id).toBe('new');
    expect(checks[0] === undefined ? true : 'memberRole' in checks[0].resource.attr).toBe(false);
  });

  it('a target with no reported memberRole sends no memberRole key', async () => {
    const { checks, call } = setupAction('resetMfa', () => true);

    await call(`target-${randomUUID()}`);

    expect(checks[1] === undefined ? true : 'memberRole' in checks[1].resource.attr).toBe(false);
  });
});
