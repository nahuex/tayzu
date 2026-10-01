# VCDM Agent — SSA Mode A Pre-Assessment: `002-auth-and-rbac` and `043-identity-lifecycle-and-org-admin`

Both skill parts confirmed loaded (SEC01–SEC10 in `SKILL.md`, SEC11–SEC16 in `SEC11-SEC16.md`). Read: `openspec/project.md`, both changes' `proposal.md`/`design.md`/`specs/*.md`/`tasks.md`, the archived `001-catalog-core` artifacts, and the current code (`packages/catalog/src/service/pipeline.ts`, `domain/context.ts`, `domain/reserved.ts`, `packages/catalog/CLAUDE.md`, `.github/workflows/ci.yml`). No code for `packages/auth`, `packages/authz`, `apps/api`, or `policies/` exists yet — this is a pure planning-artifact assessment, as Mode A expects before Checkpoint 1.

This is the first change exposing a network attack surface, so per your instruction I went adversarial on SEC02–06, 09/10, 12, 14, 16. The result is **five BLOCKING gaps**, all newly surfaced by the interaction between `002` and `043` (not visible from either change read alone), plus a number of non-blocking gaps and verification items.

## Summary

| | 002-auth-and-rbac | 043-identity-lifecycle-and-org-admin |
|---|---|---|
| COVERED | 34 | 21 |
| GAP (blocking) | 4 | 3 (2 shared with 002) |
| GAP (non-blocking) | 9 | 4 |
| HUMAN | 4 (shared across both changes) | — |

**Blocking gaps first (touch access control / injection / secrets / tenant isolation / security logging, per your own blocking definition):**

1. **Better Auth's native organization-management endpoints are a second, ungoverned authorization path.** `apps/api` mounts Better Auth's entire `/api/auth/*` handler (D13), which includes the `organization` plugin's own built-in `inviteMember`, `updateMemberRole`, `removeMember`, and `setActiveOrganization` endpoints. Nothing in `002` or `043` states these are disabled, wrapped in a Cerbos check, or restricted. This directly contradicts D2's own stated invariant ("Cerbos is the only place an authorization decision is made — running both would be the literal 'multiple ways to do access control' SEC03 anti-pattern") and creates two concrete exploitable paths: (a) a `member` promoting themselves to `admin` via Better Auth's native `updateMemberRole` call, bypassing every Cerbos role policy `002` builds; (b) `043`'s carefully Cerbos-gated `identity.users.invite` (admin-only, logged) is duplicated by Better Auth's own ungoverned `inviteMember`, which has no Cerbos check, no step-up, and no `catalog.security.*` event. SEC03/SEC14.
2. **`activeOrganizationId` (the tenant-isolation trust root) has no explicit membership-verification test.** `tenantId = session.activeOrganizationId` (D3) is the value RLS and Cerbos both key off. No task in `002` verifies that Better Auth's `setActiveOrganization` endpoint refuses to set an org the caller isn't a member of. If this native endpoint doesn't enforce that (or is affected by finding #1), tenant isolation collapses at the one seam that matters most. SEC03.
3. **No credential-stuffing/brute-force defense on unauthenticated endpoints.** The only rate limiting designed (`@fastify/rate-limit` keyed `${tenantId}:${actor.type}:${actor.id}`, D13/task 11.8) cannot apply before a caller is authenticated — sign-in, two-factor verify, and `/v1/auth/token` all run with no established actor. No IP- or email-keyed rate limiting, backoff, or lockout is designed anywhere for these endpoints. This is the textbook account-takeover/credential-stuffing gap the assignment specifically asked me to check. SEC02/SEC03/SEC06.
4. **Machine access tokens are not revocable within their 1-hour lifetime.** `002`'s spec only tests that a *revoked credential fails at the token-exchange endpoint* ("Revoked credential is rejected"). Nothing tests or guarantees that a token already issued before revocation stops working. Since the access token is a stateless signed JWT (D5), a compromised/leaked token survives up to 1 hour after the admin revokes the underlying credential — "fail closed" (SEC03 Q4) is not actually satisfied for this path. SEC03/SEC05.
5. **Service accounts can inherit `admin`/broad `moderatedBlueprints` while permanently exempt from step-up.** `043` D6 has an `integration`-typed service-account credential inherit `role`/`team`/`moderatedBlueprints` from its bound `_user` entity, with no cap on what role that entity may hold. `002`'s spec explicitly exempts `agent`/`integration`/`system` actors from the step-up gate ("governed by Cerbos policy alone"). Combined, a leaked service-account secret bound to an admin-role `_user` can execute `blueprints.delete`/`entities.delete`/`organization.delete`-class operations forever, with **no MFA ever required**, unlike the human admin it mirrors. This emergent risk did not exist when Q6 (step-up) was originally decided, because `043` (service accounts) didn't exist yet. SEC03/SEC06.

None of these require re-litigating a fixed Tayzu decision (Cerbos, Better Auth, RLS, ACA, Key Vault, OTel); they are gaps in how the design closes the loop around those decisions.

---

## Per-section table: `002-auth-and-rbac`

| Section | Applicability | Item | Status | Evidence / fix |
|---|---|---|---|---|
| SEC01 Diagram | APPLIES — first live listener, Cerbos sidecar, Key Vault | Diagram update task exists | COVERED | `design.md` D17, `tasks.md` 16.2. Not yet drawn (planning stage), task is concrete and scoped. |
| SEC02 Attack surfaces | APPLIES — first real assessment | Explicit attack-surface **table** as a committed artifact | GAP (non-blocking) | Design §"Security considerations" *asserts* every endpoint gets an auth/authz row, but no task in `tasks.md` produces a `docs/security/attack-surfaces.md` (or equivalent) artifact. Fix: add a task in group 16 to write this table (Better Auth routes, catalog routes, `/v1/auth/token`, actor categories, tech stack) before Checkpoint 2. |
| SEC02 | APPLIES | Better Auth org-management endpoints as attack surface | **GAP (BLOCKING)** | See Summary #1. Fix: explicit design decision + task disabling or Cerbos-wrapping `inviteMember`/`updateMemberRole`/`removeMember`/`setActiveOrganization`. |
| SEC02 | APPLIES | One credential per org, never shared | COVERED | D5: `apiKey` config `references: "organization"`, credential is org-scoped by construction. |
| SEC03 Access control | APPLIES, core of change | Server-side only, deny-by-default, distinct from not-found | COVERED | Spec "Authorization is decided by Cerbos and fails closed"; `strictEvaluation: true` (D7); `AUTH_FORBIDDEN` vs `CATALOG_NOT_FOUND` distinguished by spec scenario and D11. |
| SEC03 | APPLIES | Step-up for high-risk ops | PARTIAL / GAP (BLOCKING interaction with 043) | Correct for human actors (D4); creates the service-account bypass in Summary #5. |
| SEC03 | APPLIES | Credential-stuffing / brute-force protection | **GAP (BLOCKING)** | See Summary #3. |
| SEC03 | APPLIES | Revoked credential invalidates already-issued tokens | **GAP (BLOCKING)** | See Summary #4. Fix: either shorten token lifetime further, add a revocation-check (e.g., a lightweight denylist keyed by credential id, checked in `resolveContext`), or explicitly document/accept the residual window and add a metric for it. |
| SEC03 | APPLIES | `onBehalfOf` population/validation over HTTP | GAP (non-blocking but should close before Checkpoint 1) | `CatalogContext.actor.onBehalfOf` (001 D3) is "reused, not redefined" per both designs, but neither `002`'s `resolveContext(headers)` (task 3.1) nor any other task states *how* an HTTP caller supplies `onBehalfOf` or what validates it isn't forged (confused-deputy / audit-forgery risk: an integration caller falsely attributing an action to an innocent user). Fix: design.md should state whether `onBehalfOf` is even reachable over HTTP in `002`'s scope, and if so, how it's authenticated (e.g., must be a claim in the caller's own token, never a client-supplied field). |
| SEC03 | APPLIES | Multiple ways to do access control (anti-pattern) | GAP (BLOCKING, same as #1) | `dynamicAccessControl` correctly disabled (D2) — good — but Better Auth's own org-role endpoints remain a second path (see #1). |
| SEC04 Password storage | APPLIES | Better Auth default hashing (scrypt), no second store | COVERED | Design "Security considerations" table, SEC04 row. |
| SEC05 Crypto | APPLIES | TLS on public ingress, SSL Labs check | GAP (non-blocking) | "TLS on the ACA ingress ... new" is asserted with no task verifying HSTS/TLS1.0-1.1 disabled or running an SSL Labs-equivalent check, as SEC05's checklist requires. `@fastify/helmet` (task 11.6) likely sets HSTS by default but this isn't asserted. Fix: add a verification task. |
| SEC05 | APPLIES | Cerbos sidecar loopback with no TLS | COVERED, documented exception | Resolved decision Q8 — deliberate, scoped, justified (same network namespace, no external reachability). |
| SEC05 | APPLIES | API-key hash algorithm not independently source-verified | GAP (non-blocking, dangling reference) | Design's own Risks section says this is "tracked as a pre-Checkpoint-2 verification task (11.x in tasks.md)" — **no such task exists** in the actual `tasks.md` group 11 (11.1–11.8 are all HTTP-listener plumbing). Fix: add the missing verification task or correct the cross-reference. |
| SEC06 Misuse | APPLIES | Notifications on password/MFA/session-revocation change | COVERED | `auth.security.login_succeeded/failed`, `session_revoked` (D14, Observability contract). |
| SEC06 | APPLIES | Account-enumeration on sign-up/sign-in/reset | GAP (non-blocking) | No forgot-password/reset flow is designed at all (not stated as in-scope or explicitly deferred), and no scenario addresses whether responses reveal account existence. Fix: state reset-flow scope explicitly (in-scope now, or deferred to a named change) and add an enumeration-resistance requirement. |
| SEC06 | APPLIES | ORM/SQL-injection, framework XSS protection | COVERED (carried from 001) | Drizzle parameterized queries, `sql.raw` banned by lint (project.md invariant), reused unchanged. |
| SEC07 Dependencies | APPLIES | New deps on existing SCA/audit/EOL gate | COVERED | Proposal "Dependencies"; design D17 note "extends 001's existing Dependabot/`pnpm audit` gate, no new gate." |
| SEC08 File upload | N/A | No upload surface | COVERED (justified) | Correctly N/A — nothing in scope touches file handling. |
| SEC09 Secrets in code | APPLIES | gitleaks scan | COVERED | Already in `.github/workflows/ci.yml` (`gitleaks` job) from `001`; `002` tasks (17.1) reuse it, no gap. |
| SEC10 Secret management | APPLIES | Key Vault for DB role passwords, `BETTER_AUTH_SECRET`, jwt signing key | COVERED | D15, task 14.1, with a config-loading test asserting fail-fast on missing secret and a documented change procedure per secret. |
| SEC11 Phishing | PARTIAL | No invitation email in this change's scope | COVERED (correctly deferred) | Design explicitly notes invitations are `043`'s concern; only clickable link, if any, is email-verification (optional). |
| SEC12 Testing/QA | APPLIES | Security-relevant unit/integration tests, DAST | COVERED | `cerbos compile` test suites gate every policy; OWASP ZAP baseline (D16, task 15.1) is the first real DAST job, correctly scoped as passive/baseline only (Escape's active DAST is `022`, explicitly not claimed here). |
| SEC12 | APPLIES | Post-launch monitoring robustness (SEC12 Q3) | GAP (non-blocking) | Not explicitly answered in design's SSA table (folded generically into "Yes"). Fix: state explicitly whether monitoring is Robust/Weak, since Azure Monitor dashboards/alerts aren't otherwise described in this change. |
| SEC13 Deployment | APPLIES | Pinned images, SHA-pinned CI actions | COVERED | Cerbos image pinned by digest (D7); ZAP action "pinned by commit SHA" (task 15.1). |
| SEC14 Infra permissions | APPLIES, core of change | Three-role split, no bypass, no shared account | COVERED, with one clarity item | `tayzu_migrator`/`tayzu_app`/`tayzu_auth` (D6), `FORCE ROW LEVEL SECURITY`, revoked `UPDATE/DELETE/TRUNCATE` on `catalog_change_event`. Minor doc-accuracy gap: design's role table labels `tayzu_migrator`'s RLS column "Bypasses (owner)," but `FORCE ROW LEVEL SECURITY` (correctly used here) applies RLS to the table owner too, unless it separately holds `BYPASSRLS`. Not a security gap (migrator is confirmed unreachable at runtime by a negative-control test, task 6.4) — just a documentation correction to make before Checkpoint 3 sign-off on this migration. |
| SEC15 Network/host | PARTIAL | PaaS-only, Key Vault via managed identity | COVERED (correctly scoped) | No new host surface; managed identity stated explicitly, not a stored credential. |
| SEC16 Logging | APPLIES | Auth/authz audit events, sampling exemption, marker-leak tests | COVERED | Extensive: `auth.security.*`, `catalog.security.authz_denied`, exemption list extended with client secrets/tokens/TOTP/backup codes (D14), task 13.3 marker-leak test. |
| SEC16 | APPLIES | Cerbos decision-log retention | GAP (non-blocking, deferred) | `audit.decisionLogsEnabled: true` with no retention policy stated for this change (reasonable to defer to `010`/`015`, but should say so explicitly rather than being silent). |

## Per-section table: `043-identity-lifecycle-and-org-admin`

| Section | Applicability | Item | Status | Evidence / fix |
|---|---|---|---|---|
| SEC01 Diagram | APPLIES | New external actor (email provider), new arrows | COVERED | Task 13.6, D12. |
| SEC02 Attack surfaces | APPLIES | Ten new routes, each with actor/auth/Cerbos check | COVERED | D10 table, mapped to Cerbos resource kinds in D3. |
| SEC02 | APPLIES | Better Auth's native `inviteMember` duplicating `identity.users.invite` | **GAP (BLOCKING, same root cause as 002 finding #1)** | `043` builds a careful Cerbos-gated, logged, audited invite path — but if `002`'s mounted `/api/auth/*` still exposes Better Auth's own native invite endpoint, `043`'s entire invitation-hardening effort (SEC11) can be bypassed by calling the native endpoint directly. This must be resolved as part of `002`'s fix (see Summary #1), and `043` should add a task asserting the native endpoint is disabled or gated equivalently. |
| SEC03 Access control | APPLIES, core of change | Cerbos-gated (not origin-gated), self-status-change denied, fail-closed | COVERED | D3/ADR-0020 explicitly rejects Port's origin-based gating in favor of `project.md`'s actor-parity invariant — a genuinely strong design choice, well-reasoned and tested (spec "A user cannot disable themselves"). |
| SEC03 | APPLIES | Step-up for `setStatus`/`credentials.rotate`/`credentials.revoke`/`organization.delete` | PARTIAL — see 002 finding #5 | Correctly required for `user` actors; the service-account/step-up-exemption interaction is the shared blocking gap. |
| SEC03 | APPLIES | Org-deletion confirmation-by-identifier (not a boolean) | COVERED | Spec requirement + task 10.6, defends against a careless double-click/CSRF-adjacent accidental deletion. |
| SEC04 Password storage | N/A | No new password store | COVERED (justified) | Reuses `002`'s hashing. |
| SEC05 Crypto | PARTIAL | Invitation tokens opaque, TLS to Azure Communication Services | COVERED | Managed-service TLS, correctly scoped as "Partial" (no new crypto primitive introduced). |
| SEC06 Misuse | APPLIES | Expired/cancelled/rejected invitation acceptance always fails; org deletion idempotent | COVERED | Extensive scenario coverage (spec "Invitation lifecycle", "Org deletion revokes access immediately..."). |
| SEC06 | APPLIES | Email enumeration via invitation-accept error messages | GAP (non-blocking) | Spec doesn't state whether "accepting a nonexistent/foreign invitation" and "accepting with mismatched email" produce indistinguishable errors — worth a scenario making this explicit, since invitation flows are a classic enumeration surface. |
| SEC07 Dependencies | APPLIES | `@azure/communication-email` added to existing gate | COVERED | Task 1.3, D12. |
| SEC08 File upload | N/A | No upload surface | COVERED (justified) | |
| SEC09/10 Secrets | APPLIES | ACS connection string as new Key Vault secret | COVERED | Task 1.3, reuses `002`'s Key Vault pattern, documented change procedure planned in `docs/security/data-retention.md`'s companion note. |
| SEC11 Phishing | APPLIES, this change's core new exposure | 48h expiry, exactly one link, email-match-before-accept, re-invite invalidates old link | COVERED — strong | D4/D5, spec scenarios are thorough and match the skill's own best practices almost exactly (limiting links, no attachments, validated dynamic content). |
| SEC11 | APPLIES | Rate limiting / recipient limits on invite-send (SEC11 best practice) | GAP (non-blocking) | Skill's SEC11 best practices ask for a maximum-recipients limit and rate limiting on the messaging feature to stop the platform being used to blast phishing-style invites; not addressed. An admin (or a compromised admin session) could mass-invite. Fix: add a per-tenant invite-rate cap. |
| SEC12 Testing | APPLIES | `cerbos compile`, scenario-backed tests, ZAP reuse | COVERED | D11, correctly notes existing ZAP baseline covers new routes with no new DAST job needed. |
| SEC13 Deployment | PARTIAL | One new env var, no new deploy step | COVERED (justified) | |
| SEC14 Infra permissions | N/A | No new DB roles/grants | COVERED (justified) | Correctly reuses `002`'s roles; no new migration (D9's "zero new migrations" goal is honored). |
| SEC15 Network/host | PARTIAL | New outbound call to Azure Communication Services | COVERED | Documented as new egress in system diagram (task 13.6). |
| SEC16 Logging | APPLIES | Nine new audit/security events, sampling-exempt | COVERED | Observability contract is thorough: `catalog.audit.*` (invitation, service account, credential rotation, org deletion) and `catalog.security.*` (denied self-status-change, credential revocation, invitation-acceptance denial with a `denial_reason` enum). Marker-leak tests specified (task 12.4). |
| SEC16 | APPLIES | Org-deletion audit event logged **before** the row disappears | COVERED | D9/D12 explicitly sequences this via Better Auth's `afterDeleteOrganization` hook, with a dedicated test (task 10.4) asserting log-precedes-deletion ordering — good defensive design against "the evidence disappears with the tenant." |

---

## Proposed improvement tickets

1. **(BLOCKING, 002+043)** Audit and lock down Better Auth's native organization-management endpoints (`inviteMember`, `updateMemberRole`, `removeMember`, `setActiveOrganization`) mounted via `/api/auth/*`; either disable them at the routing layer or gate them with the same Cerbos check their oRPC equivalents get.
2. **(BLOCKING, 002)** Add an explicit test/task verifying `setActiveOrganization` (or whatever sets `session.activeOrganizationId`) refuses an org the caller isn't a member of.
3. **(BLOCKING, 002)** Add IP/email-keyed rate limiting and/or lockout on sign-in, two-factor verify, and `/v1/auth/token`, distinct from the per-tenant-actor `@fastify/rate-limit` bucket.
4. **(BLOCKING, 002)** Decide and implement how a revoked machine credential invalidates already-issued access tokens within their 1-hour window (or explicitly document and monitor the residual-validity risk).
5. **(BLOCKING, 043)** Restrict the role a service account's bound `_user` entity may hold (recommend: `member` only, never `admin`), or otherwise close the step-up-exemption/elevated-role interaction.
6. Add a committed SEC02 attack-surface table artifact (`docs/security/attack-surfaces.md` or equivalent) as a `002` task deliverable.
7. Add the missing `002` task 11.x referenced by design's Risks section (API-key hashing algorithm source verification), or correct the dangling cross-reference.
8. Add a `002` task/scenario verifying TLS posture on the public ACA ingress (HSTS present, TLS 1.0/1.1 disabled), consistent with SEC05's checklist.
9. State explicitly whether/how `002` supports a forgot-password/reset flow, and add an account-enumeration-resistance requirement for sign-up/sign-in/reset.
10. Define (in `002`) how and whether `CatalogContext.actor.onBehalfOf` is populated and authenticated over HTTP, to prevent audit-attribution forgery.
11. Add a `043` scenario making invitation-related error responses indistinguishable for enumeration purposes (nonexistent invitation vs. email mismatch vs. wrong state).
12. Add a per-tenant rate/volume cap on `identity.users.invite` (SEC11 best practice: limit messaging-feature abuse).
13. Correct `002` design D6's RLS-column description for `tayzu_migrator` (owner exemption vs. `FORCE ROW LEVEL SECURITY`) for accuracy at Checkpoint 3 review.
14. Explicitly state Cerbos decision-log and Azure Monitor post-launch-monitoring robustness (SEC12 Q3, SEC16) in `002`'s design rather than folding it silently into "Yes."

## Questions for the human

**Q1. Better Auth's native org-management endpoints — how should they be neutralized?**
1. Disable Better Auth's native `inviteMember`/`updateMemberRole`/`removeMember`/`setActiveOrganization` endpoints entirely at the Fastify routing layer, forcing every org-membership mutation through Cerbos-gated oRPC procedures that call `auth.api.*` internally. **(Recommended)** — cleanest match to "Cerbos is the sole authorization engine" and closes both the privilege-escalation path and the `043` invite-bypass path in one fix.
2. Keep the endpoints mounted but add a Fastify pre-handler that runs a Cerbos check before delegating to `auth.handler` for these specific sub-routes.
3. Rely on Better Auth's own internal owner/admin checks for these endpoints, with no additional Cerbos check — accepted as a Better-Auth-owned (not Tayzu-owned) authorization mechanism.
4. Defer the decision to `025-sso-and-identity-federation`.

**Q2. Should `activeOrganizationId`/tenant-switch membership be independently re-verified, beyond trusting Better Auth's own check?**
1. Add an explicit Tayzu-side test in `002` asserting non-membership is rejected, plus a defense-in-depth re-check inside `resolveContext()` independent of Better Auth's own logic. **(Recommended)** — this value is the literal root of tenant isolation; defense in depth here is cheap and proportionate to the blast radius of getting it wrong.
2. Add only the test (trust Better Auth's documented behavior, no extra code).
3. Trust Better Auth's behavior with neither an explicit test nor extra code.
4. Defer to `042-multi-org`, since `002`'s stated model assumes "few known tenants, no org switcher."

**Q3. How should credential-stuffing/brute-force protection be added for pre-authentication endpoints?**
1. Add a second, IP+email-keyed rate-limit/lockout layer specifically for sign-in, two-factor verification, and `/v1/auth/token`, as a new `002` task before Checkpoint 2. **(Recommended)** — this is the first internet-facing listener; account-takeover protection on it shouldn't wait for a later change.
2. Rely on Better Auth's own built-in rate limiting (if any exists) without a Tayzu-specific verification task.
3. Defer this to an infrastructure-side control (e.g., Azure Front Door/WAF) added in a later change.
4. Accept the residual risk for Phase 1 ("few known tenants") and record it explicitly as an accepted risk in `design.md`.

**Q4. Should service accounts be restricted from holding `admin`/broad `moderatedBlueprints`, given they never go through step-up?**
1. Restrict service accounts to `member` role only at creation time (validation + a Cerbos rule blocking `admin`/broad-moderator grants on `accountKind: "service"` entities). **(Recommended)** — cheapest fix, matches least-privilege, and doesn't reopen `002`'s already-approved decision that non-human actors skip step-up.
2. Allow admin-role service accounts but add a secondary approval/friction mechanism for high-risk operations performed by non-human actors bound to an admin `_user`.
3. Accept the current design as-is: a compromised service-account secret has exactly the power of the admin it's bound to, with no MFA layer, because the credential itself is already a strong, hashed, revocable secret.
4. Document this as an explicit residual risk in `043`'s design.md with no code change, revisiting only if an incident or a real integration need arises.

## Resolution

Answered by the human on 2026-09-28: Q1=a, Q2=a, Q3=a, Q4=a, plus a new Q5
(not in this report's original question set, covering Summary finding #4 /
ticket-equivalent gap directly below) = a. Every blocking gap and every
non-blocking ticket this report raised is now closed in `002`'s and `043`'s
`design.md`/`specs/*.md`/`tasks.md`, as follows.

**Blocking gaps:**

1. **Better Auth's native organization/apiKey routes (Summary #1, `002`
   ticket 1, Q1).** Closed by `002` design D18: a deny-by-default Fastify
   route allowlist in front of `/api/auth/*`; every native org-mutation and
   apiKey-management route returns `404`. Spec: "Only an allowlisted set of
   Better Auth routes is reachable over HTTP" (`002`). Tasks: 11.9 (blocking
   test), 11.10 (allowlist-drift test). `043`'s own invite-bypass exposure
   (this report's `043` SEC02 row) closes as a direct consequence — the
   native `inviteMember` route it would have been reachable through is now
   blocked by the same allowlist.
2. **`activeOrganizationId` membership re-verification (Summary #2, `002`
   ticket 2, Q2).** Closed by `002` design D19: a test on
   `setActiveOrganization` plus an independent, briefly-cached,
   fail-closed re-check inside `resolveContext()`. Spec: "Tenant-switch
   membership is independently re-verified" (`002`). Tasks: 3.5, 3.6.
3. **Pre-authentication brute-force protection (Summary #3, `002` ticket 3,
   Q3).** Closed by `002` design D20: Better Auth `rateLimit` with
   `storage: "database"` and IP+email-keyed `customRules` for sign-in/
   two-factor/sign-up; a separate IP+client-id-keyed `@fastify/rate-limit`
   bucket on `POST /v1/auth/token`. The `rateLimit` table lands inside the
   already-Checkpoint-3-gated Better Auth schema migration (task 2.2), not a
   new one. Spec: "Pre-authentication rate limiting protects against
   credential stuffing" (`002`). Tasks: 2.5, 11.13, plus `auth.security.
   rate_limited`/`tayzu.auth.rate_limit.events` in the telemetry contract.
4. **Machine access tokens not revocable within their 1-hour lifetime
   (Summary #4, `002` ticket 4, new Q5).** This report flagged the gap
   (Summary #4, ticket 4) but had not yet been posed to the human as a
   numbered question; the human answered it explicitly on 2026-09-28 as Q5:
   a Postgres revocation list (`machine_credential_revocation`), consulted by
   `resolveContext()` through a cache of at most 5 seconds TTL, fail-closed
   on lookup failure. Closed by `002` design D21 — a **new migration**,
   Checkpoint 3 applies separately (task 5.5). Spec: the "Machine
   credentials" requirement now states the revocation-immediacy guarantee
   directly, with its own scenario. Tasks: 5.5, 5.6, 5.7.
5. **Service-account step-up-exemption/elevated-role interaction (Summary
   #5, `043` ticket 5, Q4).** Closed by `043` design D6/D3: service accounts
   restricted to `member` role, never `admin`, never a Moderator grant,
   enforced at both `identity.serviceAccounts.create`'s input validation and
   an independent Cerbos rule on `002`'s `user` resource policy, keyed on
   `accountKind: "service"`. `002` design D8 confirms no new mechanism is
   needed on `002`'s side (the existing dynamic-ABAC pattern already covers
   this). Spec: "Service accounts are non-human users created API-only"
   extended (`043`). Tasks: 6.5, 7.7, 7.8. Resolved decision Q7 (`043`).

**Non-blocking tickets:**

6. **Attack-surface doc artifact** → `002` task 16.4,
   `docs/security/attack-surfaces.md`.
7. **Dangling `11.x` cross-reference (API-key hash verification)** → `002`
   task 11.11, and the design's Risks/SEC05 entries now cite it by number.
8. **TLS/HSTS verification** → `002` task 11.12.
9. **Password-reset scope + enumeration resistance** → `002` design
   Non-Goals: forgot-password/account-recovery is out of scope, deferred to
   a new named change, `044-password-reset-and-account-recovery` (`043`
   does not naturally absorb it — it owns identity lifecycle depth, not a
   second auth flow). Sign-up/sign-in enumeration-resistance requirement
   added to `002`'s spec ("Authentication responses resist account
   enumeration"), task 2.6.
10. **`onBehalfOf` not accepted over HTTP** → `002` design D3 states it
    explicitly; spec scenario "A client-supplied onBehalfOf value is
    ignored"; task 3.4.
11. **`043` invitation errors indistinguishable** → `043` design D4; spec
    scenario "Invitation-acceptance errors do not reveal which failure
    occurred"; task 4.9.
12. **`043` per-tenant invite rate cap** → `043` design D4 addition, new
    spec requirement "Per-tenant invitation rate limiting"; task 4.10.
13. **`002` D6 migrator RLS wording** → corrected in `002` design D6's role
    table.
14. **Cerbos decision-log retention/monitoring statement** → `002` design D7
    states retention (Azure Monitor, no Cerbos-side policy of its own) and
    names the alerting concern as `010`-owned, explicitly rather than folded
    into "Yes".

Zero blocking gaps remain open for either change as of this resolution.
