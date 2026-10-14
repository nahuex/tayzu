import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildIdentityResource } from './identity-attributes.js';
import type { IdentityOperation } from './identity-attributes.js';

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
