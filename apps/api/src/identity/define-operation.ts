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
import { emitIdentityEvent } from '@tayzu/auth';
import { recordAuthzDecision } from '@tayzu/catalog';

import { buildIdentityResource, type IdentityOperation } from './identity-attributes.js';
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

/** The Cerbos action whose self-target deny is a security signal (design D3). */
const STATUS_ACTION = 'updateStatus';

/** Any operation of the kind with a resolved target: it only picks the resource kind (design D3). */
const TARGET_OPERATION: Record<ResourceKind, IdentityOperation> = {
  [RESOURCE_KINDS.user]: 'users.setStatus',
  [RESOURCE_KINDS.serviceAccount]: 'serviceAccounts.delete',
  [RESOURCE_KINDS.credential]: 'credentials.rotate',
} as Record<ResourceKind, IdentityOperation>;

export interface IdentityOperationDeps {
  readonly authz: CerbosClient;
  readonly targetResolver: IdentityTargetResolver;
}

type ResourceAttributes = NonNullable<
  Parameters<CerbosClient['checkResources']>[0]['resources'][number]['resource']['attr']
>;

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
    resource: { readonly id: string; readonly attr: ResourceAttributes },
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
            resource: { kind, id: resource.id, attr: resource.attr },
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
    // The targetless check of a listing names the fixed id `list`; every other one names `new`.
    const callerResourceId = action === 'list' ? 'list' : 'new';
    const procedure = makeProcedure(options.route, async ({ context, input }) => {
      const caller = parseCaller(context);

      const callerAllowed = await isAllowed(caller, kind, action, {
        id: callerResourceId,
        attr: buildAttributes(caller.tenantId, callerExtra),
      });
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
        const targetAllowed = await isAllowed(caller, kind, action, {
          id: target.id,
          attr: buildIdentityResource({
            operation: TARGET_OPERATION[kind],
            targetId: target.id,
            tenantId: target.tenantId,
            // A resolver that read no `_user` leaves the kind's default (design D3).
            entity: {
              spec: {
                properties: {
                  accountKind: target.attributes?.accountKind ?? callerExtra['accountKind'],
                },
              },
            },
            ...(target.attributes?.portRole === undefined
              ? {}
              : { portRole: target.attributes.portRole }),
            ...(target.attributes?.moderatedBlueprints === undefined
              ? {}
              : { moderatedBlueprints: target.attributes.moderatedBlueprints }),
          }).attr as ResourceAttributes,
        });
        if (!targetAllowed) {
          recordAuthzDecision(
            { tenantId: caller.tenantId, actor: caller.actor },
            kind,
            action,
            false,
          );
          // Design D3: the policy denies `updateStatus` on oneself; the target id is the
          // resolved Better Auth user id, so an email-addressed self-target is caught too.
          if (action === STATUS_ACTION && target.id === caller.actor.id) {
            emitIdentityEvent({
              name: 'catalog.security.self_status_change_denied',
              severity: 'WARN',
              attributes: { 'tayzu.tenant.id': caller.tenantId, 'tayzu.actor.id': caller.actor.id },
            });
          }
          throw new IdentityForbiddenError();
        }
      }

      return options.handler({ context, input, target });
    });
    BRANDED.add(procedure);
    return procedure;
  };
}
