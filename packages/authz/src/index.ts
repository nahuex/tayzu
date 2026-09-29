/**
 * @tayzu/authz: Cerbos client, attribute builders and resource-kind
 * constants (openspec/changes/002-auth-and-rbac, D7).
 */
export { createCerbosClient } from './client.js';
export type { CerbosClient, CerbosClientOptions } from './client.js';
export { RESOURCE_KINDS } from './resource-kinds.js';
export type { ResourceKind } from './resource-kinds.js';
export { buildAttributes } from './attributes.js';
