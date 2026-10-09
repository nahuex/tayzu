/** The fixed Cerbos resource kinds (002 design D7; `043` design D3 adds two). */
export const RESOURCE_KINDS = {
  catalogBlueprint: 'catalog_blueprint',
  catalogEntity: 'catalog_entity',
  team: 'team',
  user: 'user',
  serviceAccount: 'service_account',
  credential: 'credential',
} as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[keyof typeof RESOURCE_KINDS];
