import { RESOURCE_KINDS, buildAttributes } from '@tayzu/authz';
import type { ResourceKind } from '@tayzu/authz';

/** Every identity operation that is authorized through Cerbos (`043` design D3). */
export type IdentityOperation =
  | 'invite'
  | 'invitations.cancel'
  | 'invitations.resend'
  | 'users.create'
  | 'users.setStatus'
  | 'users.linkSsoAccount'
  | 'users.unlinkSsoAccount'
  | 'serviceAccounts.create'
  | 'serviceAccounts.delete'
  | 'credentials.create'
  | 'credentials.list'
  | 'credentials.rotate'
  | 'credentials.revoke';

export interface IdentityResourceInput {
  readonly operation: IdentityOperation;
  /** The opaque id of the resolved target; ignored by the operations that have none yet. */
  readonly targetId?: string;
  /** The target's real tenant (never the caller's, echoed back). */
  readonly tenantId: string;
  /** The target's `_user` entity, when one was resolved. */
  readonly entity?: { readonly spec: { readonly properties: Record<string, unknown> } };
  readonly portRole?: string;
  readonly moderatedBlueprints?: readonly string[];
}

export interface IdentityResource {
  readonly kind: ResourceKind;
  readonly id: string;
  readonly attr: Record<string, unknown>;
}

const KIND: Record<IdentityOperation, ResourceKind> = {
  invite: RESOURCE_KINDS.user,
  'invitations.cancel': RESOURCE_KINDS.user,
  'invitations.resend': RESOURCE_KINDS.user,
  'users.create': RESOURCE_KINDS.user,
  'users.setStatus': RESOURCE_KINDS.user,
  'users.linkSsoAccount': RESOURCE_KINDS.user,
  'users.unlinkSsoAccount': RESOURCE_KINDS.user,
  'serviceAccounts.create': RESOURCE_KINDS.serviceAccount,
  'serviceAccounts.delete': RESOURCE_KINDS.serviceAccount,
  'credentials.create': RESOURCE_KINDS.credential,
  'credentials.list': RESOURCE_KINDS.credential,
  'credentials.rotate': RESOURCE_KINDS.credential,
  'credentials.revoke': RESOURCE_KINDS.credential,
};

/** Operations whose resource does not exist yet, or has no target: a fixed literal id. */
const FIXED_ID: Partial<Record<IdentityOperation, string>> = {
  invite: 'new',
  'users.create': 'new',
  'serviceAccounts.create': 'new',
  'credentials.create': 'new',
  'credentials.list': 'list',
};

/** Builds the Cerbos resource of an identity operation from a resolved target. */
export function buildIdentityResource(input: IdentityResourceInput): IdentityResource {
  const kind = KIND[input.operation];
  const id = FIXED_ID[input.operation] ?? input.targetId ?? '';
  const extra: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (kind !== RESOURCE_KINDS.credential) {
    const read = input.entity?.spec.properties['accountKind'];
    extra['accountKind'] =
      input.operation === 'serviceAccounts.create'
        ? 'service'
        : typeof read === 'string'
          ? read
          : 'standard';
  }
  if (input.portRole !== undefined) extra['portRole'] = input.portRole;
  if (input.moderatedBlueprints !== undefined) {
    extra['moderatedBlueprints'] = [...input.moderatedBlueprints];
  }
  return { kind, id, attr: buildAttributes(input.tenantId, extra) };
}
