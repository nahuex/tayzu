/**
 * The identity-lifecycle telemetry contract (043, Resolved decision Q74),
 * kept apart from `./contract.ts`, whose test requires it to equal the authz
 * contract's `auth.*` subset exactly. No name is declared yet: 13.3 declares
 * the four `002` Q42 names here and 15.1 the rest.
 */
export const IDENTITY_SPANS: readonly string[] = [];
export const IDENTITY_METRICS: readonly string[] = [];
export const IDENTITY_LOG_EVENTS: readonly string[] = [];
