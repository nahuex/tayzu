# ADR-0015: Cerbos uses dynamic context, not scoped policies, for tenancy and ABAC

- **Status**: Accepted
- **Date**: 2026-09-29
- **Change**: [`002-auth-and-rbac`](../../openspec/changes/002-auth-and-rbac/design.md) (design D7, D8, D10)

## Context

Tayzu is multi-tenant, and each tenant defines its own blueprints. Cerbos
offers two ways to express tenancy: `scope`d policies (one policy tree per
tenant) and a "dynamic context" pattern, where tenant and resource facts are
plain attributes on the principal and the resource. Tenants also need
attribute-based rules, for example ownership and locking, without a runtime
"write a policy" API in Phase 1.

## Decision

1. **No Cerbos `scope` is used.** `tenantId` is a plain attribute on the
   principal and the resource.
2. A derived role `same_tenant` (`parentRoles: ["*"]`, condition
   `R.attr.tenantId == P.attr.tenantId`) is imported into every rule of every
   resource policy, and every resource policy has an explicit cross-tenant
   deny. This is defense in depth on top of Postgres RLS, not a replacement
   for it. A `PlanResources` `ALWAYS_ALLOWED` result is composed with the
   mandatory tenant filter, never used to skip it.
3. **Resource kinds are fixed** (`catalog_blueprint`, `catalog_entity`,
   `team`, `user`), not one per blueprint. Blueprint identity is the
   `blueprintId` attribute.
4. **Dynamic ABAC is static policy plus dynamic context.** The service layer
   passes attributes (`ownerTeam`, `createdBy`, `locked`, and later others);
   rules are CEL conditions in the existing `catalog_entity` policy, changed
   only at deploy time through Checkpoint 3. A _grant_ adds an allowance
   inside the role ceiling (ADR-0013). A _deny_ is an explicit, documented
   exception and names the principals it exempts (an admin stays exempt).
5. The worked examples (Resolved decision Q22) are a grant of `delete` where
   `resource.createdBy == principal.id`, and a deny of `update` for non-admin
   principals where `resource.locked == true`. `ownerTeam` is absent, not
   null, when an entity has no owner, so rules test `has(R.attr.ownerTeam)`
   (Q25).

## Alternatives considered

- **Scoped policies per tenant.** Rejected: a policy tree per tenant is far
  too large to hand-review at Checkpoint 3 and needs runtime policy
  provisioning that Phase 1 does not have.
- **One resource kind per blueprint.** Rejected: it mints a policy file per
  blueprint, with the same review and provisioning cost.
- **A runtime policy-authoring API for tenant admins.** Rejected for Phase 1:
  it bypasses the Checkpoint 3 approval of every policy change.

## Consequences

- `/policies` stays small enough to review by hand.
- Tenant isolation rests on three layers: the service's tenant filter, RLS
  and the `same_tenant` role plus explicit deny. A rule that forgets a tenant
  check still cannot cross tenants.
- Cerbos must never compute domain facts, so the service must supply every
  attribute a rule uses. `043`'s `accountKind` rule is one more attribute and
  condition, not a new mechanism.
- Per-tenant customization of rules needs a design change and a new
  Checkpoint 3 approval until a runtime policy story exists.

## Update (2026-09-30)

The decision stands, with one qualification to point 2 and to the
"three layers" consequence. The catalog pipeline and the `entities.list` plan
send the host-resolved `ctx.tenantId` as both `R.attr.tenantId` and
`P.attr.tenantId` (`buildAttributes` in `packages/authz/src/attributes.ts`
drops any `tenantId` in the extra attributes). For catalog operations,
`same_tenant` is therefore always true and the explicit cross-tenant deny
never fires: Postgres RLS and the repository `tenant_id` filters are the real
barriers. The "defense in depth" holds only for `identity.*`, which passes the
target's real tenant, resolved from its memberships, as the resource tenant.
A full fix comes with Cerbos scopes (`042`). Read point 2 and the
Consequences with this in mind.
