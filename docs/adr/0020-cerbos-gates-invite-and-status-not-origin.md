# ADR-0020: Cerbos gates invite and status change, not the request origin

- **Status**: Accepted
- **Date**: 2026-10-13
- **Change**: [`043-identity-lifecycle-and-org-admin`](../../openspec/changes/043-identity-lifecycle-and-org-admin/design.md) (design D3; Resolved decisions Q7, Q16, Q45, Q62, Q90, Q119)

## Context

Port documents that only users with a UI or API origin can invite users and
change their status. That rule gates on how a request arrived, not on who
makes it. Tayzu committed to the opposite principle in `project.md` §1 and in
the root `CLAUDE.md`: `actor.type` is data and never selects a code path, and
there is one operation pipeline for humans and agents.

Change `043` adds the identity operations of an organization admin: invite
(with cancel and resend), change a user's status, create and delete a service
account, and list, create, rotate and revoke a machine credential. Each needs
an authorization decision, and each touches a different tenant-owned target
(an invitation, a user, an API key).

Two facts from `002` shape the decision. `strictEvaluation: true` turns a CEL
error in a policy into a deny of the whole action. And the `same_tenant`
derived role is vacuous unless the caller passes the **target's real tenant**
as the resource tenant, so a check made with the caller's own tenant proves
nothing about a target of another tenant.

## Decision

1. **Cerbos is the only decision point, and the role is the only gate.** Every
   identity operation is an action on a Cerbos resource, allowed to the
   `admin` role. The request origin (UI, API, agent) is never read.

   | Resource kind     | Actions                                           |
   | ----------------- | ------------------------------------------------- |
   | `user` (existing) | `invite` (also cancel and resend), `updateStatus` |
   | `service_account` | `create`, `delete`                                |
   | `credential`      | `list`, `create`, `rotate`, `revoke`              |

2. **Two new resource kinds.** `RESOURCE_KINDS` in
   `packages/authz/src/resource-kinds.ts` gains `service_account` and
   `credential`. `policies/role_policies/admin.yaml` lists each kind and its
   actions one by one (no wildcard resource), because it is a ceiling and
   without the entries the admin is denied fail-closed. The allows live in
   `service_account.yaml` and `credential.yaml`, each with the explicit
   cross-tenant `EFFECT_DENY` that `002` D8 requires, and `member` has no rule
   in either, so every action stays denied by default.

3. **`user.yaml` gains two deny rules and no allow.** It already allows `*` to
   `admin`, so `invite` and `updateStatus` need no new allow, and an allow
   cannot narrow `*` anyway. The denies are: `updateStatus` when
   `R.id == P.id` (nobody changes their own status), and the service-account
   ceiling of Q7 and Q16 (any action on a resource whose `accountKind` is
   `service` and whose resulting `portRole` is not `member` or whose
   `moderatedBlueprints` is non-empty). Every attribute reference is guarded
   with `has()`, so an absent `accountKind` is `standard` and the rule does not
   fire. The ceiling is a defensive layer independent of the input validation
   of `identity.serviceAccounts.create`, proven at the policy level.

4. **The `service_account` kind refuses any other target type** (Q62). Its
   policy denies every action unless `R.attr.accountKind == "service"`, so a
   route of this kind can never act on a human `_user`, even if the
   server-side resolution of the target were bypassed.

5. **`R.id` is opaque.** For a human it is the Better Auth user id, never the
   email: a self-deny compared with an email would be vacuous against `P.id`,
   and Cerbos's decision log (`decisionLogsEnabled: true`) would record the
   email. A service account uses its `svc-…` identifier (Q90). The fixed
   resource ids are the literal `new` where no resource exists yet, the
   invitation id for cancel and resend, the Better Auth user id (or `svc-…`
   identifier) for a status change or a service account's deletion, and the
   `apikey` id for rotate and revoke. Q119 extends the rule to the catalog:
   the entities of the reserved `_user` blueprint send a fixed placeholder as
   `resource.id`, and the referrer redaction sends positional ids.

6. **The check is mandatory and structural.** `defineIdentityOperation`
   (`apps/api/src/identity/define-operation.ts`, Q45) is the only way to build
   an identity procedure, and a test forbids a bare handler. It first asks
   Cerbos about the caller's role in the caller's own tenant, with no target.
   It then resolves the target on the server, and asks again with the target's
   real tenant, which is the tenant of the invitation, the API key's
   `referenceId` or the user's membership, never the caller's. Any Cerbos
   error, malformed context or empty role list is a deny. A target of another
   tenant is resolved as `CATALOG_NOT_FOUND` before Cerbos is asked, so it
   looks exactly like an unknown target.

## Alternatives considered

- **Keep Port's origin rule as a second check on top of Cerbos.** Rejected: it
  is the actor-or-origin-as-code-path pattern that `project.md` forbids, and
  the role-based deny of Cerbos already gives the protection it would add.
- **Narrow `user.yaml` with new allow rules for `invite` and `updateStatus`.**
  Rejected: the existing `*` allow to `admin` cannot be overridden by an allow,
  so narrowing would need a restructure of the policy for no gain. Two denies
  say exactly what is forbidden.
- **Keep calling `assertMayOnUser` by hand in each handler.** Rejected (Q45):
  it accepts only `create` and `update`, sends no attributes and depends on
  every handler remembering to call it. The mandatory wrapper makes an
  unchecked route impossible to write.
- **Check only the caller's tenant.** Rejected: `same_tenant` is vacuous unless
  the target's real tenant is passed, so a cross-tenant target would pass.
- **Send the email as the resource id for a human.** Rejected: it makes the
  self-deny vacuous and writes a member's email to the decision log.

## Consequences

- Every change to the three kinds is a Cerbos policy change and stops at
  Checkpoint 3.
- The invite and status operations behave the same for a human admin and for
  any other actor that holds the `admin` role. There is no origin-specific
  path to test or to keep in sync.
- Each target costs two Cerbos requests: the caller's role check and the check
  with the target's real tenant. In exchange a missing or failed resolution
  can never reach a decision with the wrong tenant.
- Only opaque ids reach the decision log of the identity router, and with Q119
  the catalog's `_user` checks too.
- In the code, the wrapper's second check passes the resource tenant and, for
  the `service_account` kind, `accountKind: service`; it does not yet pass the
  target's `portRole` and `moderatedBlueprints`. The service-account ceiling
  of `user.yaml` is therefore proven by the policy tests and a `system`-actor
  test (Q16) and not through an identity route: no operation of this change
  edits a role or `moderatedBlueprints`. A future operation that does must pass
  those attributes.
- The wrapper's first, target-less check sends the resource id `new` for every
  operation, including `credentials.list`, where the design names the literal
  `list`. The policies read no resource id, so the decision is the same.
