/**
 * Cross-capability OpenTelemetry attribute keys (task 6.1,
 * openspec/changes/archive/2026-09-28-001-catalog-core; design.md, "Observability contract" ->
 * "Shared attribute keys"; R15). Defined once so every capability (001's
 * catalog, and 002/004/008 later) shares one vocabulary instead of each
 * repeating the same five literal strings.
 *
 * This module has no imports and creates no OTel instrument: it is plain
 * data, safe to import from a library that depends on the OTel API only
 * (never the SDK), for example `@tayzu/catalog/src/telemetry/contract.ts`.
 */

/** design.md, "Shared attribute keys": the five cross-capability keys, and no more. */
export const sharedAttributeKeys = {
  tenantId: 'tayzu.tenant.id',
  actorType: 'tayzu.actor.type',
  actorId: 'tayzu.actor.id',
  actorOnBehalfOfType: 'tayzu.actor.on_behalf_of.type',
  actorOnBehalfOfId: 'tayzu.actor.on_behalf_of.id',
} as const;

export type SharedAttributeKey = (typeof sharedAttributeKeys)[keyof typeof sharedAttributeKeys];
