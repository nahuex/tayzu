/**
 * Task 5.3b3 of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * requirement "Every identity route declares its authorization"; Resolved
 * decision Q57).
 *
 * Scenario: "The wrapper fails closed"
 *
 * - WHEN Cerbos errors, the context is malformed or the caller has no roles
 * - THEN the operation is denied and the handler does not run
 *
 * ## Production symbols expected (already present from 5.3b)
 *
 * ```ts
 * // apps/api/src/identity/define-operation.ts
 * export function createDefineIdentityOperation(deps: { authz: CerbosClient; targetResolver: IdentityTargetResolver }): DefineIdentityOperation;
 * ```
 */
import { createRouterClient } from '@orpc/server';
import { RESOURCE_KINDS, type CerbosClient } from '@tayzu/authz';
import { describe, expect, it, vi } from 'vitest';

import { createDefineIdentityOperation } from './define-operation.js';
import type { IdentityTargetResolver } from './identity-target.js';

const CALLER_TENANT = 'tenant-caller';

type Context = Record<string, unknown>;

function validContext(): Context {
  return {
    tenantId: CALLER_TENANT,
    actor: { type: 'user', id: 'actor-1' },
    principal: { roles: ['admin'] },
  };
}

/** `failOnCall`: 0-based index of the Cerbos call that throws; otherwise every call allows. */
function setup(options: { failOnCall?: number; withTarget?: boolean } = {}) {
  let calls = 0;
  const checkResources = vi.fn(() => {
    const index = calls++;
    if (index === options.failOnCall) return Promise.reject(new Error('cerbos unavailable'));
    return Promise.resolve({ results: [{ isAllowed: () => true }] });
  });
  const authz = { checkResources } as unknown as CerbosClient;
  const resolve = vi.fn((_context: { tenantId: string }, raw: unknown) => {
    const { kind, id } = raw as { kind: 'user'; id: string };
    return Promise.resolve({ kind, id, tenantId: CALLER_TENANT });
  });
  const targetResolver = { resolve } as unknown as IdentityTargetResolver;
  const define = createDefineIdentityOperation({ authz, targetResolver });

  const handler = vi.fn(() => Promise.resolve({ ok: true }));
  const op = define({
    authorization: {
      kind: RESOURCE_KINDS.user,
      action: 'update',
      resolveTarget: () =>
        options.withTarget === false ? undefined : { kind: 'user' as const, id: 'target-1' },
    },
    handler,
  });
  const client = createRouterClient({ op }, { context: (raw: Context) => raw }) as unknown as {
    op(input: unknown, options: { context: Context }): Promise<unknown>;
  };
  return {
    checkResources,
    resolve,
    handler,
    call: (context: Context) => client.op({ id: 'target-1' }, { context }).catch((e: unknown) => e),
  };
}

describe('defineIdentityOperation fails closed (task 5.3b3)', () => {
  it('The wrapper fails closed: a Cerbos client that throws on the caller-tenant check denies', async () => {
    const { call, handler, resolve } = setup({ failOnCall: 0 });

    const answer = await call(validContext());

    expect(answer).toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(handler).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('The wrapper fails closed: a Cerbos client that throws on the target check denies', async () => {
    const { call, handler } = setup({ failOnCall: 1 });

    const answer = await call(validContext());

    expect(answer).toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('The wrapper fails closed: a context with no tenant denies', async () => {
    const { call, handler, checkResources } = setup();
    const context = validContext();
    delete context['tenantId'];

    const answer = await call(context);

    expect(answer).toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(handler).not.toHaveBeenCalled();
    expect(checkResources).not.toHaveBeenCalled();
  });

  it('The wrapper fails closed: a context with no actor denies', async () => {
    const { call, handler, checkResources } = setup();
    const context = validContext();
    delete context['actor'];

    const answer = await call(context);

    expect(answer).toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(handler).not.toHaveBeenCalled();
    expect(checkResources).not.toHaveBeenCalled();
  });

  it('The wrapper fails closed: a principal with an empty role list denies', async () => {
    const { call, handler, checkResources } = setup();

    const answer = await call({ ...validContext(), principal: { roles: [] } });

    expect(answer).toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(handler).not.toHaveBeenCalled();
    expect(checkResources).not.toHaveBeenCalled();
  });

  it('A well-formed context with a working Cerbos client still runs the handler', async () => {
    const { call, handler } = setup();

    const answer = await call(validContext());

    expect(answer).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
