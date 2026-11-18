import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AuthRepository } from './auth-repository.js';
import { buildIdentityResource } from './identity-attributes.js';
import type { IdentityOperation } from './identity-attributes.js';
import { createIdentityTargetResolver } from './identity-target.js';

/**
 * `043` task 5.1 (design D3, Resolved decisions Q62, Q90): the Cerbos resource of
 * an identity operation is built from a resolved target. It carries the target's
 * real tenant (never the caller's, echoed back), the three user attributes, and an
 * opaque, fixed resource id (never an email).
 */

const CALLER_TENANT = `caller-${randomUUID()}`;
const TARGET_TENANT = `target-${randomUUID()}`;

function userEntity(properties: Record<string, unknown>): {
  spec: { properties: Record<string, unknown> };
} {
  return { spec: { properties } };
}

describe('buildIdentityResource attributes', () => {
  it('the attributes carry the target tenant and the three attributes', () => {
    const resource = buildIdentityResource({
      operation: 'users.setStatus',
      targetId: 'ba-user-1',
      tenantId: TARGET_TENANT,
      entity: userEntity({ accountKind: 'service' }),
      portRole: 'member',
      moderatedBlueprints: ['service'],
    });

    expect(resource.kind).toBe('user');
    expect(resource.attr.tenantId).toBe(TARGET_TENANT);
    expect(resource.attr.tenantId).not.toBe(CALLER_TENANT);
    expect(resource.attr.accountKind).toBe('service');
    expect(resource.attr.portRole).toBe('member');
    expect(resource.attr.moderatedBlueprints).toEqual(['service']);
  });

  it('the resource id is the opaque id for an email-addressed target', () => {
    const email = `ada-${randomUUID()}@example.com`;
    const resource = buildIdentityResource({
      operation: 'users.setStatus',
      targetId: 'ba-user-42',
      tenantId: TARGET_TENANT,
      entity: userEntity({ email, accountKind: 'standard' }),
      portRole: 'member',
      moderatedBlueprints: [],
    });

    expect(resource.id).toBe('ba-user-42');
    expect(JSON.stringify(resource)).not.toContain(email);
  });

  it('a `_user` read without accountKind is sent as standard', () => {
    const resource = buildIdentityResource({
      operation: 'users.setStatus',
      targetId: 'ba-user-7',
      tenantId: TARGET_TENANT,
      entity: userEntity({ status: 'Active' }),
      portRole: 'member',
      moderatedBlueprints: [],
    });

    expect(resource.attr.accountKind).toBe('standard');
  });

  it('a service_account resource carries the resolved accountKind', () => {
    const resource = buildIdentityResource({
      operation: 'serviceAccounts.delete',
      targetId: 'svc-abc123',
      tenantId: TARGET_TENANT,
      entity: userEntity({ accountKind: 'service' }),
      portRole: 'member',
      moderatedBlueprints: [],
    });

    expect(resource.kind).toBe('service_account');
    expect(resource.attr.accountKind).toBe('service');
    expect(resource.attr.tenantId).toBe(TARGET_TENANT);
  });

  it('a service_account whose resolved target is a standard user carries standard', () => {
    const resource = buildIdentityResource({
      operation: 'serviceAccounts.delete',
      targetId: 'ba-user-9',
      tenantId: TARGET_TENANT,
      entity: userEntity({}),
      portRole: 'member',
      moderatedBlueprints: [],
    });

    expect(resource.attr.accountKind).toBe('standard');
  });

  it('a service_account create carries accountKind service', () => {
    const resource = buildIdentityResource({
      operation: 'serviceAccounts.create',
      tenantId: CALLER_TENANT,
    });

    expect(resource.kind).toBe('service_account');
    expect(resource.attr.accountKind).toBe('service');
    expect(resource.attr.tenantId).toBe(CALLER_TENANT);
  });

  it('a credential resource carries the target tenant', () => {
    const resource = buildIdentityResource({
      operation: 'credentials.rotate',
      targetId: 'apikey-1',
      tenantId: TARGET_TENANT,
    });

    expect(resource.kind).toBe('credential');
    expect(resource.attr.tenantId).toBe(TARGET_TENANT);
  });
});

describe('buildIdentityResource resource id', () => {
  const tenantId = TARGET_TENANT;

  const cases: readonly {
    operation: IdentityOperation;
    kind: string;
    targetId?: string;
    expectedId: string;
  }[] = [
    { operation: 'invite', kind: 'user', expectedId: 'new' },
    { operation: 'users.create', kind: 'user', expectedId: 'new' },
    { operation: 'serviceAccounts.create', kind: 'service_account', expectedId: 'new' },
    { operation: 'credentials.create', kind: 'credential', expectedId: 'new' },
    { operation: 'invitations.cancel', kind: 'user', targetId: 'inv-1', expectedId: 'inv-1' },
    { operation: 'invitations.resend', kind: 'user', targetId: 'inv-2', expectedId: 'inv-2' },
    { operation: 'users.setStatus', kind: 'user', targetId: 'ba-user-3', expectedId: 'ba-user-3' },
    {
      operation: 'serviceAccounts.delete',
      kind: 'service_account',
      targetId: 'svc-xyz',
      expectedId: 'svc-xyz',
    },
    {
      operation: 'users.linkSsoAccount',
      kind: 'user',
      targetId: 'ba-user-4',
      expectedId: 'ba-user-4',
    },
    {
      operation: 'users.unlinkSsoAccount',
      kind: 'user',
      targetId: 'ba-user-5',
      expectedId: 'ba-user-5',
    },
    { operation: 'credentials.rotate', kind: 'credential', targetId: 'key-1', expectedId: 'key-1' },
    { operation: 'credentials.revoke', kind: 'credential', targetId: 'key-2', expectedId: 'key-2' },
    { operation: 'credentials.list', kind: 'credential', expectedId: 'list' },
  ];

  it.each(cases)(
    '$operation uses the resource id $expectedId on kind $kind',
    ({ operation, kind, targetId, expectedId }) => {
      const resource = buildIdentityResource({
        operation,
        tenantId,
        ...(targetId === undefined ? {} : { targetId }),
        entity: userEntity({
          accountKind: operation.startsWith('serviceAccounts') ? 'service' : 'standard',
        }),
        portRole: 'member',
        moderatedBlueprints: [],
      });

      expect(resource.kind).toBe(kind);
      expect(resource.id).toBe(expectedId);
    },
  );

  it('a create never takes the id from a target', () => {
    const resource = buildIdentityResource({
      operation: 'users.create',
      targetId: 'someone@example.com',
      tenantId,
    });

    expect(resource.id).toBe('new');
  });
});

/**
 * Task 10.2 of `044-password-reset-and-account-recovery`: `buildIdentityResource` passes the
 * target's raw tenant role string to Cerbos as `memberRole`, for a user target only.
 *
 * Production symbols expected: operation `'users.resetMfa'` in `IdentityOperation` (kind
 * `user`, the target id as resource id) and the optional input field `memberRole?: string`.
 */
describe('buildIdentityResource memberRole (044 task 10.2)', () => {
  it('a user target carries the memberRole string and the target id', () => {
    const resource = buildIdentityResource({
      operation: 'users.resetMfa',
      targetId: 'ba-user-11',
      tenantId: TARGET_TENANT,
      memberRole: 'member',
    });

    expect(resource.kind).toBe('user');
    expect(resource.id).toBe('ba-user-11');
    expect(resource.attr.tenantId).toBe(TARGET_TENANT);
    expect(resource.attr.memberRole).toBe('member');
  });

  it('a composite role string arrives unmodified', () => {
    for (const role of ['admin,owner', 'member,admin', 'owner']) {
      const resource = buildIdentityResource({
        operation: 'users.resetMfa',
        targetId: 'ba-user-12',
        tenantId: TARGET_TENANT,
        memberRole: role,
      });

      expect(resource.attr.memberRole).toBe(role);
    }
  });

  it('no memberRole key is sent when none was reported', () => {
    const resource = buildIdentityResource({
      operation: 'users.resetMfa',
      targetId: 'ba-user-13',
      tenantId: TARGET_TENANT,
    });

    expect('memberRole' in resource.attr).toBe(false);
  });

  it('a credential or service_account resource never carries memberRole', () => {
    const credential = buildIdentityResource({
      operation: 'credentials.rotate',
      targetId: 'key-3',
      tenantId: TARGET_TENANT,
      memberRole: 'member',
    });
    const service = buildIdentityResource({
      operation: 'serviceAccounts.delete',
      targetId: 'svc-3',
      tenantId: TARGET_TENANT,
      memberRole: 'member',
    });

    expect('memberRole' in credential.attr).toBe(false);
    expect('memberRole' in service.attr).toBe(false);
  });
});

/**
 * Task 3.1 of `045-org-deletion-and-data-retention` (design D6; spec requirement "The
 * deletion route is authorized, step-up gated, tenant-bound and mounted behind the
 * switch": "The target of the Cerbos check MUST be the host tenant, passed as the real
 * tenant"). The target of `organization.delete` is the host tenant itself: the target kind
 * `organization` resolves to the host tenant with no lookup, and the Cerbos resource's real
 * tenant and opaque resource id are both the host tenant id, never a value read from input.
 *
 * Production symbols expected: `'organization'` in `IdentityTargetKind`
 * (`identity-target.ts`), operation `'organization.delete'` in `IdentityOperation` mapped to
 * `RESOURCE_KINDS.organization` (`identity-attributes.ts`).
 */
describe('organization.delete resource (045 task 3.1)', () => {
  const HOST_TENANT = `host-${randomUUID()}`;
  const INPUT_VALUE = `input-${randomUUID()}`;

  /** An auth repository that fails the test on any read: the organization target needs none. */
  function noLookupRepository(): { repository: AuthRepository; reads: string[] } {
    const reads: string[] = [];
    const repository = new Proxy(Object.create(null) as object, {
      get(_target, property) {
        reads.push(String(property));
        throw new Error('the organization target must resolve with no lookup');
      },
    }) as AuthRepository;
    return { repository, reads };
  }

  it('the organization target resolves to the host tenant with no lookup', async () => {
    const { repository, reads } = noLookupRepository();
    const resolver = createIdentityTargetResolver({ authRepository: repository });

    const target = await resolver.resolve(
      { tenantId: HOST_TENANT },
      { kind: 'organization', id: HOST_TENANT },
    );

    expect(target.kind).toBe('organization');
    expect(target.id).toBe(HOST_TENANT);
    expect(target.tenantId).toBe(HOST_TENANT);
    expect(reads).toEqual([]);
  });

  it('the organization target never takes its id or tenant from input', async () => {
    const { repository, reads } = noLookupRepository();
    const resolver = createIdentityTargetResolver({ authRepository: repository });

    const target = await resolver.resolve(
      { tenantId: HOST_TENANT },
      { kind: 'organization', id: INPUT_VALUE },
    );

    expect(target.id).toBe(HOST_TENANT);
    expect(target.tenantId).toBe(HOST_TENANT);
    expect(JSON.stringify(target)).not.toContain(INPUT_VALUE);
    expect(reads).toEqual([]);
  });

  it('the Cerbos resource of organization.delete carries the host tenant as tenant and id', async () => {
    const { repository } = noLookupRepository();
    const resolver = createIdentityTargetResolver({ authRepository: repository });
    const target = await resolver.resolve(
      { tenantId: HOST_TENANT },
      { kind: 'organization', id: INPUT_VALUE },
    );

    const resource = buildIdentityResource({
      operation: 'organization.delete',
      targetId: target.id,
      tenantId: target.tenantId,
    });

    expect(resource.kind).toBe('organization');
    expect(resource.attr.tenantId).toBe(HOST_TENANT);
    expect(resource.id).toBe(HOST_TENANT);
    expect(JSON.stringify(resource)).not.toContain(INPUT_VALUE);
  });

  it('organization.delete builds an organization resource whose tenant and id are the host tenant', () => {
    const resource = buildIdentityResource({
      operation: 'organization.delete',
      targetId: HOST_TENANT,
      tenantId: HOST_TENANT,
    });

    expect(resource.kind).toBe('organization');
    expect(resource.attr.tenantId).toBe(HOST_TENANT);
    expect(resource.id).toBe(HOST_TENANT);
  });
});
