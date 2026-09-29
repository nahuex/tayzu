/**
 * Ownership resolution (design D9): the service layer resolves an entity's
 * effective owner team before every Cerbos call. Cerbos never walks relations.
 */
export type EffectiveOwnerTeam =
  | { readonly kind: 'None' }
  | { readonly kind: 'Direct'; readonly teamId: string }
  | { readonly kind: 'Inherited'; readonly teamId: string };

export interface OwnershipConfig {
  /** Relation name holding the entity's own team, when configured. */
  readonly directTeamRelation?: string;
  /** Declared relation chain to walk for inherited ownership. */
  readonly inheritedChain?: readonly string[];
}

export interface ResolveOwnerInput {
  readonly config: OwnershipConfig | undefined;
  readonly entity: { readonly relations: Readonly<Record<string, string | undefined>> };
  /** Walks the inherited chain; only called when no direct relation applies. */
  readonly readInherited: (chain: readonly string[]) => string | undefined;
}

/**
 * Direct wins over Inherited: once the entity has a direct team relation the
 * inherited path is never consulted (design D9, Port conflict rule).
 */
export function resolveEffectiveOwnerTeam(input: ResolveOwnerInput): EffectiveOwnerTeam {
  const { config, entity, readInherited } = input;
  if (config?.directTeamRelation !== undefined) {
    const relations = entity.relations;
    const direct = Object.hasOwn(relations, config.directTeamRelation)
      ? relations[config.directTeamRelation]
      : undefined;
    if (direct !== undefined && direct !== '') return { kind: 'Direct', teamId: direct };
  }
  if (config?.inheritedChain !== undefined && config.inheritedChain.length > 0) {
    const inherited = readInherited(config.inheritedChain);
    if (inherited !== undefined && inherited !== '') {
      return { kind: 'Inherited', teamId: inherited };
    }
  }
  return { kind: 'None' };
}
