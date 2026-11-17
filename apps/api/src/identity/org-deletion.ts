/**
 * Org deletion (`045` design D1, D4, D6): phase 1 of the two-phase deletion of a tenant
 * (revoke now, record the deletion marker, notify the admins) behind
 * `identity.organization.delete`. Filled in by the tasks of group 5.
 */
import { IdentityInputError, type InputSchema } from './parse-input.js';

/**
 * The detailed input of `identity.organization.delete` (design D6): the confirmation travels
 * in the query string only, so a body is refused by the strict parser.
 */
export const ORG_DELETION_INPUT_SCHEMA = {
  query: { confirmation: { kind: 'string', maxLength: 64 } },
} as const satisfies InputSchema;

export interface RequestOrgDeletionOptions {
  /** The host tenant (`ctx.tenantId`), never a value read from input. */
  readonly tenantId: string;
  /** The parsed `query.confirmation`: the organization identifier the caller typed. */
  readonly confirmation: string;
}

/**
 * Phase 1 of org deletion. The confirmation must name the host tenant (design D1 "Phase 1,
 * request"); anything else fails with `CATALOG_VALIDATION_FAILED` before any write.
 */
export function requestOrgDeletion(options: RequestOrgDeletionOptions): Promise<void> {
  if (options.confirmation !== options.tenantId) {
    return Promise.reject(new IdentityInputError());
  }
  return Promise.resolve();
}
