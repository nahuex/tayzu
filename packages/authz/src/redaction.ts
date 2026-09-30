import type { CerbosClient } from './client.js';
import { buildAttributes } from './attributes.js';
import type { ResourceKind } from './resource-kinds.js';

/** A Cerbos attribute value (JSON-like). */
export type RedactionAttribute =
  string | number | boolean | null | RedactionAttribute[] | { [key: string]: RedactionAttribute };

/** A candidate identifier plus the attributes Cerbos needs to decide `view`. */
export interface RedactionCandidate {
  readonly id: string;
  readonly attributes?: Readonly<Record<string, RedactionAttribute>>;
}

export interface RedactUnreadableInput {
  readonly authz: CerbosClient;
  readonly tenantId: string;
  readonly actor: { readonly id: string };
  readonly principal: {
    readonly roles: readonly string[];
    readonly teams: readonly string[];
    readonly moderatedBlueprints: readonly string[];
  };
  readonly kind: ResourceKind;
  readonly candidates: readonly RedactionCandidate[];
}

/** Readable identifiers (original order) and a count of the unreadable ones. */
export interface RedactionResult {
  readonly readable: string[];
  readonly notVisible: number;
}

/**
 * One batch `CheckResources(view)` over the candidates (D12). Unreadable
 * identifiers are never named: they only contribute to `notVisible`. A
 * candidate missing from the Cerbos response counts as unreadable (fail closed).
 */
export async function redactUnreadable(input: RedactUnreadableInput): Promise<RedactionResult> {
  if (input.candidates.length === 0) return { readable: [], notVisible: 0 };

  const response = await input.authz.checkResources({
    principal: {
      id: input.actor.id,
      roles: [...input.principal.roles],
      attr: buildAttributes(input.tenantId, {
        teams: [...input.principal.teams],
        moderatedBlueprints: [...input.principal.moderatedBlueprints],
      }),
    },
    resources: input.candidates.map((candidate) => ({
      resource: {
        kind: input.kind,
        id: candidate.id,
        attr: buildAttributes<Record<string, RedactionAttribute>>(
          input.tenantId,
          candidate.attributes,
        ),
      },
      actions: ['view'],
    })),
  });

  const allowed = new Set<string>();
  for (const result of response.results) {
    if (result.isAllowed('view') === true) allowed.add(result.resource.id);
  }
  const readable = input.candidates.map((c) => c.id).filter((id) => allowed.has(id));
  return { readable, notVisible: input.candidates.length - readable.length };
}
