import { PlanKind, queryPlanToDrizzle } from '@cerbos/orm-drizzle';

type PlanArgs = Parameters<typeof queryPlanToDrizzle>[0];
type PlanResult = ReturnType<typeof queryPlanToDrizzle>;

/** The `PlanResources` response the filter is built from. */
export type QueryPlan = PlanArgs['queryPlan'];
/** Maps Cerbos attribute references to Drizzle columns. */
export type PlanColumnMapper = PlanArgs['mapper'];

/**
 * What a query plan means for a list query (design D7, D11): `denied` reads
 * nothing; `allowed` carries an extra `filter` only for a conditional plan.
 * An `ALWAYS_ALLOWED` plan has no filter, and the caller still applies its own
 * mandatory tenant scope: a plan never replaces it.
 */
export type PlanFilter =
  | { readonly kind: 'denied' }
  | {
      readonly kind: 'allowed';
      readonly filter?: Extract<PlanResult, { filter: unknown }>['filter'];
    };

/** Turns a `PlanResources` response into a Drizzle filter. An unmapped attribute throws, which denies. */
export function planToFilter(queryPlan: QueryPlan, mapper: PlanColumnMapper): PlanFilter {
  const result = queryPlanToDrizzle({ queryPlan, mapper });
  switch (result.kind) {
    case PlanKind.ALWAYS_DENIED:
      return { kind: 'denied' };
    case PlanKind.ALWAYS_ALLOWED:
      return { kind: 'allowed' };
    case PlanKind.CONDITIONAL:
      return { kind: 'allowed', filter: result.filter };
    default:
      return { kind: 'denied' };
  }
}
