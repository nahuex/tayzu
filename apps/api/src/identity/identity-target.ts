/**
 * Server-side resolution of every target of an `identity.*` operation (design
 * D14, spec "Targets belong to the caller's tenant"). The helper reads only
 * through the auth repository, always with the host tenant, so a target of
 * another tenant answers exactly like a nonexistent id.
 */
import type { AuthRepository } from './auth-repository.js';

export type IdentityTargetKind = 'invitation' | 'credential' | 'user';

export interface ResolvedIdentityTarget {
  readonly kind: IdentityTargetKind;
  readonly id: string;
  /** The target's real tenant: the host tenant once resolved. */
  readonly tenantId: string;
}

export interface IdentityTargetResolver {
  /** `rawTarget` is untrusted: exactly `{ kind, id }`; any other field is rejected before any read. */
  resolve(context: { tenantId: string }, rawTarget: unknown): Promise<ResolvedIdentityTarget>;
}

/** Same code as the catalog's not-found; a foreign and a nonexistent target are indistinguishable. */
class IdentityTargetNotFoundError extends Error {
  readonly code = 'CATALOG_NOT_FOUND' as const;

  constructor() {
    super('The requested resource was not found');
    this.name = 'IdentityTargetNotFoundError';
  }
}

/** Fixed message: never echoes the offending field or value. */
class IdentityTargetInvalidError extends Error {
  readonly code = 'CATALOG_VALIDATION_FAILED' as const;

  constructor() {
    super('The target is invalid');
    this.name = 'IdentityTargetInvalidError';
  }
}

const KINDS: readonly string[] = ['invitation', 'credential', 'user'];

function parseTarget(raw: unknown): { kind: IdentityTargetKind; id: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new IdentityTargetInvalidError();
  }
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('id')) {
    throw new IdentityTargetInvalidError();
  }
  const { kind, id } = raw as { kind: unknown; id: unknown };
  if (typeof kind !== 'string' || !KINDS.includes(kind) || typeof id !== 'string' || id === '') {
    throw new IdentityTargetInvalidError();
  }
  return { kind: kind as IdentityTargetKind, id };
}

export function createIdentityTargetResolver(options: {
  authRepository: AuthRepository;
}): IdentityTargetResolver {
  const { authRepository } = options;

  async function lookup(tenantId: string, kind: IdentityTargetKind, id: string) {
    switch (kind) {
      case 'invitation':
        return authRepository.invitationById(tenantId, id);
      case 'credential':
        return authRepository.apiKeyById(tenantId, id);
      case 'user':
        return authRepository.userInTenant(tenantId, id);
    }
  }

  return {
    async resolve(context, rawTarget) {
      const { kind, id } = parseTarget(rawTarget);
      const found = await lookup(context.tenantId, kind, id);
      if (found === undefined) throw new IdentityTargetNotFoundError();
      return { kind, id, tenantId: context.tenantId };
    },
  };
}
