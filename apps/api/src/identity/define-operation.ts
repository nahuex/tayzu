/**
 * The only way to build an identity procedure (`043` design D10, Resolved
 * decisions Q45 and Q57). Order: the caller's role in the caller's own tenant
 * (no target), then the target is resolved on the server, then Cerbos is asked
 * again with the target's real tenant, then the handler runs. Any Cerbos error,
 * malformed context or empty role list denies. The unwrapped oRPC builder is
 * never exported from this module; the brand is what the structure test checks.
 */
import { isProcedure, os, type Route } from '@orpc/server';
import {
  buildAttributes,
  RESOURCE_KINDS,
  type CerbosClient,
  type ResourceKind,
} from '@tayzu/authz';
import { recordAuthzDecision } from '@tayzu/catalog';

import type {
  IdentityTargetKind,
  IdentityTargetResolver,
  ResolvedIdentityTarget,
} from './identity-target.js';

/** Same code and message as the catalog's `AuthorizationError` (design D11). */
class IdentityForbiddenError extends Error {
  readonly code = 'AUTH_FORBIDDEN' as const;

  constructor() {
    super('Action is not permitted');
    this.name = 'IdentityForbiddenError';
  }
}

export interface IdentityOperationDeps {
  readonly authz: CerbosClient;
  readonly targetResolver: IdentityTargetResolver;
}

type RawContext = Record<string, unknown>;

export interface IdentityOperationDeclaration {
  readonly kind: ResourceKind;
  readonly action: string;
  /** `undefined` for an operation with no target: only the caller-tenant check runs. */
  readonly resolveTarget: (input: unknown) => { kind: IdentityTargetKind; id: string } | undefined;
}

export interface IdentityOperationHandlerArgs {
  readonly context: RawContext;
  readonly input: unknown;
  readonly target: ResolvedIdentityTarget | undefined;
}

export interface IdentityOperationOptions<TOutput> {
  readonly authorization: IdentityOperationDeclaration;
  readonly route?: Route;
  readonly handler: (args: IdentityOperationHandlerArgs) => Promise<TOutput> | TOutput;
}

const BRANDED = new WeakSet<object>();

/** True for a procedure returned by `defineIdentityOperation`. */
export function isIdentityOperation(procedure: unknown): boolean {
  return typeof procedure === 'object' && procedure !== null && BRANDED.has(procedure);
}

/** Dotted paths of every procedure in a router tree that is not branded. */
export function findUnbrandedProcedures(router: unknown, prefix = ''): string[] {
  if (isProcedure(router)) return isIdentityOperation(router) ? [] : [prefix];
  if (typeof router !== 'object' || router === null) return [];
  return Object.entries(router).flatMap(([key, child]) =>
    findUnbrandedProcedures(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

interface CallerContext {
  readonly tenantId: string;
  readonly actor: { readonly id: string; readonly type: string };
  readonly roles: string[];
}

/** Fails closed: anything but a well-formed host context is a deny. */
function parseCaller(context: RawContext): CallerContext {
  const { tenantId, actor, principal } = context as {
    tenantId?: unknown;
    actor?: { id?: unknown; type?: unknown } | null;
    principal?: { roles?: unknown } | null;
  };
  const roles = principal?.roles;
  if (
    !isNonEmptyString(tenantId) ||
    !isNonEmptyString(actor?.id) ||
    !Array.isArray(roles) ||
    roles.length === 0 ||
    !roles.every(isNonEmptyString)
  ) {
    throw new IdentityForbiddenError();
  }
  return {
    tenantId,
    actor: { id: actor.id, type: isNonEmptyString(actor.type) ? actor.type : 'unknown' },
    roles: [...roles],
  };
}

type Run<TOutput> = (args: { context: RawContext; input: unknown }) => Promise<TOutput>;

/** The only place the unwrapped builder is touched; not exported. */
function makeProcedure<TOutput>(route: Route | undefined, run: Run<TOutput>) {
  const builder = os.$context<RawContext>();
  return (route === undefined ? builder : builder.route(route)).handler(run);
}

export type DefineIdentityOperation = <TOutput>(
  options: IdentityOperationOptions<TOutput>,
) => ReturnType<typeof makeProcedure<TOutput>>;

export function createDefineIdentityOperation(
  deps: IdentityOperationDeps,
): DefineIdentityOperation {
  /** One Cerbos question; anything but an explicit allow is a deny. */
  async function isAllowed(
    caller: CallerContext,
    kind: ResourceKind,
    action: string,
    resourceId: string,
    resourceTenantId: string,
    extra: Record<string, string>,
  ): Promise<boolean> {
    try {
      const checked = await deps.authz.checkResources({
        principal: {
          id: caller.actor.id,
          roles: caller.roles,
          attr: buildAttributes(caller.tenantId, {}),
        },
        resources: [
          {
            resource: {
              kind,
              id: resourceId,
              attr: buildAttributes(resourceTenantId, extra),
            },
            actions: [action],
          },
        ],
      });
      return checked.results[0]?.isAllowed(action) === true;
    } catch {
      return false;
    }
  }

  return (options) => {
    const { kind, action, resolveTarget } = options.authorization;
    // The service-account policy denies every action on any other `accountKind` (design D3).
    const callerExtra: Record<string, string> =
      kind === RESOURCE_KINDS.serviceAccount ? { accountKind: 'service' } : {};
    const procedure = makeProcedure(options.route, async ({ context, input }) => {
      const caller = parseCaller(context);

      const callerAllowed = await isAllowed(
        caller,
        kind,
        action,
        'new',
        caller.tenantId,
        callerExtra,
      );
      recordAuthzDecision(
        { tenantId: caller.tenantId, actor: caller.actor },
        kind,
        action,
        callerAllowed,
      );
      if (!callerAllowed) throw new IdentityForbiddenError();

      const declared = resolveTarget(input);
      const target =
        declared === undefined
          ? undefined
          : await deps.targetResolver.resolve({ tenantId: caller.tenantId }, declared);

      if (target !== undefined) {
        const targetAllowed = await isAllowed(
          caller,
          kind,
          action,
          target.id,
          target.tenantId,
          callerExtra,
        );
        if (!targetAllowed) {
          recordAuthzDecision(
            { tenantId: caller.tenantId, actor: caller.actor },
            kind,
            action,
            false,
          );
          throw new IdentityForbiddenError();
        }
      }

      return options.handler({ context, input, target });
    });
    BRANDED.add(procedure);
    return procedure;
  };
}
