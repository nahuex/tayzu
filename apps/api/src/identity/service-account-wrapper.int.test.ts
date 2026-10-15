/**
 * Task 10.2 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (design D3
 * and D10, Resolved decision Q62): the wrapper of 5.3b2 against the real Cerbos
 * container and the `service_account` resource policy.
 *
 * - An admin passes both checks for `create` and `delete` (the first, target-less
 *   check carries `accountKind: service`).
 * - A member is denied at the first check: the handler never runs.
 *
 * Needs the Cerbos container (`localhost:3593`) with the policy loaded.
 */
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { createCerbosClient, RESOURCE_KINDS, type CerbosClient } from '@tayzu/authz';
import { describe, expect, it, vi } from 'vitest';

import { createDefineIdentityOperation } from './define-operation.js';

interface RecordedCheck {
  readonly kind: string;
  readonly id: string;
  readonly attr: Record<string, unknown>;
  readonly allowed: boolean;
}

/** The real client, with every check recorded together with its answer. */
function recordingCerbos() {
  const real = createCerbosClient({ address: 'localhost:3593', tls: false });
  const checks: RecordedCheck[] = [];
  const client = {
    checkResources: async (
      request: Parameters<CerbosClient['checkResources']>[0],
    ): Promise<Awaited<ReturnType<CerbosClient['checkResources']>>> => {
      const result = await real.checkResources(request);
      const entry = request.resources[0];
      const action = entry?.actions[0];
      if (entry === undefined || action === undefined) throw new Error('no resource in the check');
      checks.push({
        kind: entry.resource.kind,
        id: entry.resource.id,
        attr: entry.resource.attr ?? {},
        allowed: result.results[0]?.isAllowed(action) === true,
      });
      return result;
    },
  };
  return { checks, client: client as unknown as CerbosClient };
}

function setup(options: { action: 'create' | 'delete'; role: 'admin' | 'member' }) {
  const tenantId = `tenant-${randomUUID()}`;
  const { checks, client } = recordingCerbos();
  const resolve = vi.fn((context: { tenantId: string }, raw: unknown) => {
    const { kind, id } = raw as { kind: 'user'; id: string };
    return Promise.resolve({ kind, id, tenantId: context.tenantId });
  });
  const define = createDefineIdentityOperation({
    authz: client,
    targetResolver: { resolve },
  });
  const handler = vi.fn(() => Promise.resolve({ done: true }));
  const op = define({
    authorization: {
      kind: RESOURCE_KINDS.serviceAccount,
      action: options.action,
      resolveTarget: () =>
        options.action === 'delete' ? { kind: 'user' as const, id: 'svc-ci-github' } : undefined,
    },
    handler,
  });
  const router = createRouterClient(
    { op },
    { context: (raw: Record<string, unknown>) => raw },
  ) as unknown as {
    op(input: unknown, options: { context: Record<string, unknown> }): Promise<unknown>;
  };
  const context: Record<string, unknown> = {
    tenantId,
    actor: { type: 'user', id: `actor-${randomUUID()}` },
    principal: { roles: [options.role] },
  };
  return { checks, handler, resolve, call: () => router.op({}, { context }) };
}

describe('service_account through the identity wrapper (task 10.2)', () => {
  it('An admin passes both checks for create', async () => {
    const { checks, handler, call } = setup({ action: 'create', role: 'admin' });

    await expect(call()).resolves.toEqual({ done: true });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(checks[0]?.kind).toBe(RESOURCE_KINDS.serviceAccount);
    expect(checks[0]?.attr['accountKind']).toBe('service');
    expect(checks.every((check) => check.allowed)).toBe(true);
  });

  it('An admin passes both checks for delete', async () => {
    const { checks, handler, resolve, call } = setup({ action: 'delete', role: 'admin' });

    await expect(call()).resolves.toEqual({ done: true });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(checks).toHaveLength(2);
    expect(checks[0]?.attr['accountKind']).toBe('service');
    expect(checks[1]?.id).toBe('svc-ci-github');
    expect(checks[1]?.attr['accountKind']).toBe('service');
    expect(checks.every((check) => check.allowed)).toBe(true);
  });

  it.each(['create', 'delete'] as const)(
    'A member is denied at the first check for %s',
    async (action) => {
      const { checks, handler, resolve, call } = setup({ action, role: 'member' });

      await expect(call()).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

      expect(checks).toHaveLength(1);
      expect(checks[0]?.allowed).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );
});
