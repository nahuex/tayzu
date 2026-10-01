# ADR-0013: Cerbos is the only authorization engine

- **Status**: Accepted
- **Date**: 2026-09-29
- **Change**: [`002-auth-and-rbac`](../../openspec/changes/002-auth-and-rbac/design.md) (design D2, D8)

## Context

`002-auth-and-rbac` adds authentication (Better Auth) and authorization
(Cerbos). Better Auth also ships its own access-control features (`ac`,
custom roles, `dynamicAccessControl`), so two engines could each answer
"may this principal do this?". Cerbos policies also have two easy pitfalls:
a role policy that allows an action does nothing without a matching
resource-policy rule, and `parentRoles` on a role policy narrows the role to
the parent's permissions instead of inheriting them.

## Decision

1. **Cerbos is the only place an authorization decision is made.** Better
   Auth's `dynamicAccessControl` stays off. Its roles reach Cerbos as plain
   input attributes (`member.role`) and nothing else.
2. **Role policies are a ceiling, not a grant.** An action reaches a
   principal only if the role policy allows it and a resource-policy rule
   grants it. `member.yaml` includes `delete` on `catalog_entity` in its
   ceiling so that the moderator and ABAC grants can reach it, but no
   resource-policy rule grants `delete` to a plain member (Resolved decision
   Q25).
3. **`admin.yaml` has no `parentRoles`.** It sets `allowActions: ["*"]` on
   every resource kind (Q25).
4. **Default deny is Cerbos's implicit deny plus an explicit cross-tenant
   deny** (`R.attr.tenantId != P.attr.tenantId`) in every resource policy.
   A wildcard deny rule is not used because it would override `admin` (Q25).
5. Ownership (`effectiveOwnerTeam`) is computed by the service layer before
   the Cerbos call, so Cerbos consumes attributes and never walks catalog
   relations (design D9).
6. `cerbos compile` tests assert the combination of role policy and resource
   policy per resource kind, not each file type in isolation.

## Alternatives considered

- **Better Auth `ac` / custom roles doing part of the work.** Rejected: two
  engines are the "multiple ways to do access control" anti-pattern (SSA
  SEC03) and would need reconciling on every change.
- **Role policies with `parentRoles` on `admin`.** Rejected: in Cerbos it
  narrows the role to the parent's permissions, so admin would lose access.
- **A wildcard deny rule as the default deny.** Rejected: it overrides
  `admin`. Implicit deny plus the explicit cross-tenant deny gives the same
  fail-closed result.

## Consequences

- One engine, one policy tree under `policies/`, reviewed at Checkpoint 3.
- A role-policy allow without a resource-policy rule is a silent deny, so
  the combined compile tests are mandatory.
- Every new resource kind needs its own cross-tenant deny rule.
- Better Auth roles are inputs; changing what a role may do is a Cerbos
  policy change, never a Better Auth configuration change.

## Update (2026-09-30)

The decision stands. Two facts about the shipped code qualify it:

- Point 4's cross-tenant deny compares `R.attr.tenantId` with
  `P.attr.tenantId`. For catalog operations both come from the host-resolved
  `ctx.tenantId` (`buildAttributes` in `packages/authz/src/attributes.ts`
  drops any `tenantId` in the extra attributes), and the loaded entity row
  supplies only `ownerTeam`, `createdBy` and `locked`. The deny therefore
  never fires for them. Postgres RLS and the repository `tenant_id` filters
  are the real tenant barriers there. Only `identity.*` passes the target's
  real tenant as the resource tenant. A full fix comes with Cerbos scopes
  (`042`).
- The gRPC link from `apps/api` to Cerbos uses TLS, except when
  `CERBOS_ADDRESS` is `localhost`, `127.0.0.1` or `[::1]` (the sidecar and
  the CI container).
