/** The fixed Cerbos resource kinds (002 design D7). */
export const RESOURCE_KINDS = {
  catalogBlueprint: 'catalog_blueprint',
  catalogEntity: 'catalog_entity',
  team: 'team',
  user: 'user',
} as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[keyof typeof RESOURCE_KINDS];
