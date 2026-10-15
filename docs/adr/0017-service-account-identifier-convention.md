# ADR-0017: Service accounts use a non-email `svc-` identifier

- **Status**: Accepted
- **Date**: 2026-10-13
- **Change**: [`043-identity-lifecycle-and-org-admin`](../../openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin/design.md) (design D6; Resolved decisions Q7, Q12, Q16, Q40, Q56, Q62, Q90)

## Context

A service account is a non-human `_user` entity (`accountKind: "service"`) with
an organization-owned machine credential, created API-only by an admin. Unlike
a human user it has no Better Auth user or member row, no mailbox and no
invitation. It still needs an `identifier`, the value that names its `_user`
entity.

Tayzu's `_user.identifier` is not required to be email-shaped, so the
identifier of a service account can be anything the platform chooses. That
choice matters in four places:

- the credential records it as `metadata.userId`, and the token carries it as
  the `userId` attribution claim;
- the resolver, Cerbos (`R.id`) and telemetry use the same value, because
  `EntityOutput` has no separate row id (Q90);
- every service-account route must tell a service account from a human by its
  identifier and its resolved `accountKind` (Q62);
- an email-shaped identifier would look like a real address in the viewer, in
  audit trails and in any notification path.

## Decision

1. **A service-account identifier matches `^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$`.**
   It starts with `svc-` and a letter, followed by at most 58 letters, digits,
   `_` or `-`, so it is at most 63 characters and never contains `@`. The
   pattern is enforced by `isValidServiceAccountIdentifier` in
   `apps/api/src/identity/service-accounts.ts`, and a non-matching identifier
   is refused before the `_user` or the credential exists.

2. **The identifier is the service account's opaque id.** It is the credential's
   `metadata.userId`, the `userId` claim of the exchanged token, Cerbos
   `R.id` and the value telemetry uses, with no change to the catalog
   contract (Q90).

3. **The prefix is a guard, never the proof.** Every `service_account` route
   resolves its target server-side and answers `CATALOG_NOT_FOUND`, identical
   to an unknown id, unless the resolved `_user` has `accountKind == "service"`
   **and** an identifier matching `^svc-`. A human or a standard `_user` with
   an `svc-`-shaped identifier is refused too, and the branch of
   `identity.users.setStatus` is chosen by the resolved `accountKind`, never
   by the shape of the identifier alone (Q62). `accountKind` also reaches
   Cerbos, whose deny is the second layer.

4. **A service account holds `member` and an empty `moderatedBlueprints`,
   always** (Q7, Q16). Its principal is built from the signed token claim and
   never read from the `_user` (Q12), so the identifier carries no authority.

5. **Per-tenant limit.** A tenant holds at most 50 service accounts (Q56,
   configurable in `apps/api/src/config.ts`).

## Alternatives considered

- **A synthetic email at a reserved domain, such as `@service.tayzu.internal`.**
  Rejected: it invites accidental email delivery attempts and a
  lookalike-phishing risk for no behavioral benefit. Port uses a real-looking
  email at a reserved domain (`serviceaccounts.getport.io`); Tayzu does not
  need the shape.
- **A free-form identifier chosen by the admin.** Rejected: a human email or an
  admin's own address could then name a service account, and the prefix could
  not serve as a first, cheap filter on routes that act as `system`.
- **A generated opaque id (a UUID) with a separate display name.** Rejected:
  `EntityOutput` has no row id, so the id would need a catalog contract change,
  and an admin could not recognize the account in a credential listing.

## Consequences

- No service-account identifier can collide with an email address, so a human
  `_user` and a service account never share the identifier space.
- The identifier is visible in the credentials viewer, in key metadata and in
  Cerbos decisions, so an admin names a service account after its purpose and
  never puts a secret or personal data in it.
- Recreating an identifier whose earlier account left a non-revoked key behind
  is refused with `CATALOG_VALIDATION_FAILED` (Q40), so a surviving key cannot
  resolve again for the new account.
- The 63-character ceiling is longer than the 32 characters the API-key plugin
  allows for a key name, so the key carries the fixed label
  `Service account key` and the identifier lives in its metadata.
- Changing the pattern later is a contract change: stored keys and `_user`
  rows carry the identifier.
