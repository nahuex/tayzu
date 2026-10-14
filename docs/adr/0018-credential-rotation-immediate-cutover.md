# ADR-0018: Credential rotation is an immediate cutover through the revocation list

- **Status**: Accepted
- **Date**: 2026-10-13
- **Change**: [`043-identity-lifecycle-and-org-admin`](../../openspec/changes/043-identity-lifecycle-and-org-admin/design.md) (design D8; Resolved decisions Q20, Q29, Q40, Q44, Q56, Q78)

## Context

An organization admin must be able to replace a machine credential (an
integration, an agent or a service account's key) when it is exposed or when it
is due for rotation. Better Auth's `api-key` plugin has no rotate endpoint:
rotation is "create a new key, retire the old one", done by the application.

Retiring a key is not as simple as disabling it. A machine credential is
exchanged for a 1-hour access token (ADR-0016), and a token already issued
keeps working until it expires unless something rejects it. `002` requires a
revoked credential to stop working within seconds (`002` Q13, D21). That is why
`002` keeps a permanent, insert-only `machine_credential_revocation` list that
`resolveContext` consults through a cache of at most 5 seconds, failing closed.
Disabling a key with `updateApiKey` alone would leave an already-issued token
valid for up to an hour.

A rotation could also keep the old credential valid for a window, so that an
integration polling with it has time to pick up the new secret. That is real
orchestration, and no Phase-1 integration needs it yet.

## Decision

1. **Rotation is an immediate cutover.** It creates the new key, revokes the
   old one, then returns the new secret once. There is no period in which both
   credentials are meant to work. An integration still polling with the old
   credential is rejected within seconds of the rotation (the 5-second cache of
   the revocation list).

2. **Retiring a key always writes the revocation list.** Rotation and
   revocation both use `revokeMachineCredential`
   (`packages/auth/src/machine-credentials.ts`), which writes the
   `machine_credential_revocation` row **before** it disables the key. The two
   writes live on different Postgres roles and cannot share a transaction, so
   this order means a failed disable leaves the credential on the list
   (rejected by the resolver), never the reverse. A repeat is idempotent.

3. **A rotation that cannot retire the old key leaves no second credential.**
   If the revoke of the old key fails, the new key is revoked as compensation
   and the original error is rethrown. If the compensation also fails, the
   event `catalog.security.credential_rotation_incomplete` is emitted (WARN,
   with opaque tenant, actor and credential ids only) so an operator can
   finish the job.

4. **Rotations are serialized.** A Postgres transaction-scoped advisory lock is
   held for the whole operation, per service account (the same lock that
   credential creation and the account's deletion take) or, for an unbound
   integration or agent credential, per credential. Two concurrent rotations
   would otherwise each create a key and each revoke the old one, leaving two
   active credentials. The second finds the old credential revoked and an
   active one present, and fails with `CATALOG_VALIDATION_FAILED`.

5. **The new key carries the old key's identity.** Its metadata copies
   `actorKind` and `userId` (the bound service account, when there is one),
   sets `role` to `member`, records the rotating admin as `createdBy` and the
   rotation time as `rotatedAt`.

6. **A revoked credential can be rotated only to restore a service account
   that has no active credential** (Q40). A revoked unbound credential cannot be
   rotated. Because the revocation row is permanent, "disable then re-enable"
   is not a credential operation: pausing a service account is `setStatus`,
   which is reversible, and restoring a revoked credential is "rotate".

7. **Rotation is a policy default, not an enforced expiry.** The viewer shows
   `rotationDueAt`, computed as `rotatedAt` (or `createdAt` for a key never
   rotated) plus a default interval of **90 days**. No credential is
   force-disabled solely for being overdue, and a key has no hard expiry (Q20).

8. **Admins who are not the owner can rotate.** The functions are called
   headerless with `body.userId` set to the acting admin's Better Auth user id,
   because only the organization `owner` holds `apiKey` permissions by default
   (Q29). The per-key rate limit (60 verifications per hour, Q44) is plugin
   configuration, not a per-key property. The functions are exported only on
   the subpath `@tayzu/auth/machine-credentials`, which lint limits to
   `apps/api/src/identity/**` (Q78).

## Alternatives considered

- **A grace-period window, where the old key stays valid for N hours.**
  Rejected for v1: it needs a scheduled hard-revoke, a state for "retiring"
  keys and a second live secret to leak, for a benefit no Phase-1 integration
  has asked for. It is recorded as a risk and can be added later without
  changing the revocation list.
- **Disable the old key through `updateApiKey` without the revocation list.**
  Rejected: an already-issued access token would stay valid for up to an hour,
  against `002` Q13.
- **Enforce a hard expiry or force-disable overdue credentials.** Rejected
  (Q20): an overdue credential would break an integration without warning. The
  90-day due date is an indicator for the admin.
- **Overlap by default: create the new key and leave the old one for the admin
  to revoke.** Rejected: it makes a leaked secret survive the rotation that was
  meant to remove it.

## Consequences

- An integration that polls with the old credential breaks within seconds of
  the rotation. The rotation UX copy and `docs/security/data-retention.md`
  say so, and a scheduled hard-revoke is revisited only if a real integration
  needs a grace period.
- The new secret is shown once, in the response of the rotation. An admin who
  loses it rotates again.
- Each rotation adds one permanent row to `machine_credential_revocation`.
  The list is insert-only and is never pruned by rotation.
- Between the creation of the new key and the revocation of the old one, both
  exist for the length of one operation. The rotation is serialized and a
  failure revokes the new key, so this is not a coexistence window a caller can
  rely on.
- A failed compensation is the one case that can leave two usable credentials.
  It is signalled by `catalog.security.credential_rotation_incomplete`.
