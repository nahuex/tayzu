/**
 * Task 5.3b of openspec/changes/043-identity-lifecycle-and-org-admin (spec
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
import { createRouterClient } from '@orpc/server';
import { RESOURCE_KINDS, type CerbosClient } from '@tayzu/authz';
import { describe, expect, it, vi } from 'vitest';

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
