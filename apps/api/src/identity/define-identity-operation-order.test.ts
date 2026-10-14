/**
 * Task 5.3b2 of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * requirement "Every identity route declares its authorization"; Resolved
 * decision Q57).
 *
 * Scenarios:
 *
 * - "An unauthorized caller cannot tell a target from a missing one"
 * - "An unauthorized caller gets no parse error"
 * - the first check of a `service_account` operation carries `accountKind: service`
 *
 * ## Production symbols expected (already named by 5.3b)
 *
 * ```ts
 * // apps/api/src/identity/define-operation.ts
 * export function createDefineIdentityOperation(deps: { authz: CerbosClient; targetResolver: IdentityTargetResolver }): DefineIdentityOperation;
 * ```
 *
 * The input parser is modelled as a spy called from inside the handler, as
 * `parseInput` is today; the wrapper must never reach the handler (and so the
 * parser) for a caller without the grant.
 */
import { createRouterClient } from '@orpc/server';
import { RESOURCE_KINDS, type CerbosClient } from '@tayzu/authz';
import { describe, expect, it, vi } from 'vitest';

import { createDefineIdentityOperation } from './define-operation.js';
import type { IdentityTargetResolver } from './identity-target.js';

interface RecordedCheck {
  readonly resource: { kind: string; id: string; attr: Record<string, unknown> };
}

/** A Cerbos fake that records every check; `decide` is given the 0-based call index. */
function fakeCerbos(decide: (index: number) => boolean) {
  const checks: RecordedCheck[] = [];
  const client = {
    checkResources: vi.fn(
      (request: { resources: { resource: RecordedCheck['resource']; actions: string[] }[] }) => {
        const index = checks.length;
        const entry = request.resources[0];
        if (entry === undefined) throw new Error('no resource in the check');
        checks.push({ resource: entry.resource });
        const allowed = decide(index);
        return Promise.resolve({ results: [{ isAllowed: () => allowed }] });
      },
    ),
  };
  return { checks, client: client as unknown as CerbosClient };
}

const CALLER_TENANT = 'tenant-caller';

type Kind = (typeof RESOURCE_KINDS)[keyof typeof RESOURCE_KINDS];

class NotFound extends Error {
  readonly code = 'CATALOG_NOT_FOUND' as const;
}

function setup(options: { grant: boolean; kind?: Kind }) {
  const { checks, client } = fakeCerbos(() => options.grant);
  const resolve = vi.fn((_context: { tenantId: string }, raw: unknown) => {
    const { kind, id } = raw as { kind: 'user'; id: string };
    if (id === 'unknown') return Promise.reject(new NotFound('not found'));
    return Promise.resolve({ kind, id, tenantId: CALLER_TENANT });
  });
  const targetResolver = { resolve } as unknown as IdentityTargetResolver;
  const define = createDefineIdentityOperation({ authz: client, targetResolver });

  const parseInput = vi.fn((raw: unknown): { id: string } => {
    if (typeof raw !== 'object' || raw === null) throw new Error('malformed');
    const keys = Object.keys(raw);
    if (keys.length !== 1 || keys[0] !== 'id') throw new Error('undeclared field');
    return raw as { id: string };
  });
  const handler = vi.fn(({ input }: { input: unknown }) => Promise.resolve(parseInput(input)));
  const op = define({
    authorization: {
      kind: options.kind ?? RESOURCE_KINDS.user,
      action: 'update',
      resolveTarget: (input: unknown) => {
        const id =
          typeof input === 'object' && input !== null
            ? (input as Record<string, unknown>)['id']
            : undefined;
        return { kind: 'user' as const, id: id as string };
      },
    },
    handler,
  });
  const client2 = createRouterClient(
    { op },
    { context: (raw: Record<string, unknown>) => raw },
  ) as unknown as {
    op(input: unknown, options: { context: Record<string, unknown> }): Promise<unknown>;
  };
  const context: Record<string, unknown> = {
    tenantId: CALLER_TENANT,
    actor: { type: 'user', id: 'actor-1' },
    principal: { roles: ['member'] },
  };
  return {
    checks,
    resolve,
    handler,
    parseInput,
    call: (input: unknown) => client2.op(input, { context }),
  };
}

describe('defineIdentityOperation order (task 5.3b2)', () => {
  it('An unauthorized caller cannot tell a target from a missing one', async () => {
    const { resolve, handler, call } = setup({ grant: false });

    const sameTenant: unknown = await call({ id: 'existing' }).catch((e: unknown) => e);
    const unknown_: unknown = await call({ id: 'unknown' }).catch((e: unknown) => e);

    expect(sameTenant).toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(unknown_).toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect((sameTenant as Error).message).toBe((unknown_ as Error).message);
    expect(resolve).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('An authorized caller still gets CATALOG_NOT_FOUND for an unknown target', async () => {
    const { call } = setup({ grant: true });

    await expect(call({ id: 'unknown' })).rejects.toMatchObject({ code: 'CATALOG_NOT_FOUND' });
  });

  it('An unauthorized caller gets no parse error', async () => {
    const { parseInput, handler, resolve, call } = setup({ grant: false });

    const bodies: unknown[] = [
      'not-an-object',
      { id: 'target-1', undeclared: true },
      { id: 'target-1' },
    ];
    const answers: unknown[] = [];
    for (const body of bodies) answers.push(await call(body).catch((e: unknown) => e));

    for (const answer of answers) expect(answer).toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(new Set(answers.map((a) => (a as Error).message)).size).toBe(1);
    expect(parseInput).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('The first check of a service_account operation carries accountKind: service', async () => {
    const { checks, call } = setup({ grant: true, kind: RESOURCE_KINDS.serviceAccount });

    await call({ id: 'target-1' });

    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(checks[0]?.resource.kind).toBe(RESOURCE_KINDS.serviceAccount);
    expect(checks[0]?.resource.attr['accountKind']).toBe('service');
  });
});
