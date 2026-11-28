# Proposal: 048-production-hardening

**Status:** approved by the human at Checkpoint 1 on 2026-11-27 ("apruebo dale", in chat),
with the scope questions answered as Resolved decisions Q1 to Q16 and Q21 to Q28 and the
orchestrator's choices Q17 to Q20 and Q29 to Q31 of `design.md`. Task 1.1's pre-assessment
and drift-check run first; any conflict they find is asked in chat and recorded from Q32 on.

## Why

Tayzu is not yet deployed. `002`, `043`, `044`, `045` and `003` each handed the
first deployment a list of gates. Roadmap decision D13 gave them to
`046-azure-deployment-and-first-release`. An inventory on 2026-11-27 counted 81 such
gates. Ten of them need application code that does not exist yet: the migration
role, a configurable proxy trust, the browser binding of the Visma Connect step-up,
the password-hash cost, versioned auth secrets, CSP violation reports, the Cerbos
audit backend, rate limits shared across replicas, an atomic back-channel replay
guard, and the pre-purge warning. The IaC, the pipeline and the rehearsal that `046`
also owns would push it far past the roadmap's ~30-80 TDD-task budget.

On 2026-11-27 the human split the code gates into this change (roadmap decision D14,
Q1). This change is test-driven and needs no Azure access, so it runs before `046`.
`046` keeps the infrastructure, the pipeline, the sandbox rehearsal, the alerts and
the release checklist. Each gate closed here becomes a fact `046` can verify in the
deployed environment, not code that `046` has to write.

## What Changes

- **Migrations run as the migration role** (B1, Q5). `db:migrate` reads only
  `MIGRATION_DATABASE_URL`, which is always required and never falls back to
  `DATABASE_URL`. It refuses, with a fixed message, to run as any runtime role
  (`tayzu_app`, `tayzu_auth`, `tayzu_purge`, `tayzu_deletion_admin`). CI and the
  e2e and DAST scripts export the variable.
- **Proxy trust is explicit** (D3, Q6). `TRUST_PROXY_HOPS` and `TRUST_PROXY_CIDRS`
  replace the hard-coded trust of every private range. A forwarded address is
  trusted only within the hop count and only from a peer inside the CIDRs. Startup
  fails without them outside `NODE_ENV=test`.
- **The Visma Connect step-up callback is bound to the browser that started it**
  (F4, Q7). It now uses a `nonce` sent and verified, and `response_mode=query`; the
  `form_post` callback is removed. The callback requires the session cookie and
  checks it against the bound session. A mismatch is logged with a new reason,
  `session_mismatch`.
- **Passwords are hashed at OWASP's current scrypt cost** (F8, Q8). Tayzu owns
  its password hash: scrypt with `N=2^15, r=8, p=3`, a self-describing format and a
  constant-time comparison. Hashes in Better Auth's format are still verified and
  are rewritten on the next successful sign-in. The reset path uses the same
  function. **BREAKING** for the `password-reset-and-account-recovery` wording
  "Better Auth's own hash function", which becomes "the platform's password hash
  function".
- **Versioned auth secrets** (C2, Q9). `BETTER_AUTH_SECRETS`
  (`<version>:<value>,...`, the first entry current) replaces `BETTER_AUTH_SECRET`.
  It is passed to Better Auth explicitly, so a rotation keeps TOTP secrets, backup
  codes, OAuth tokens and the JWKS private key readable. A runbook documents the
  rotation, including the JWKS rotation, and says that cookie signing still signs
  every session out. **BREAKING** for deployment configuration: the old variable is
  refused.
- **CSP violation reports** (D8, Q10). `POST /v1/csp-reports` is a public route that
  always answers `204`. The policy names it through `report-uri` and through
  `report-to` with a `Reporting-Endpoints` header. The route records only a counter,
  `tayzu.web.csp_violations`, by effective directive. It never reads a URL, a sample
  or any other field of the report.
- **The Cerbos decision log reaches stdout in production** (G3, Q15). A new
  `config/cerbos.production.yaml` is tested to equal the local file except for the
  audit backend. A test also checks that the attributes Tayzu sends to Cerbos are a
  closed set with no tenant free text.
- **Shared rate limits where they guard the public edge** (D10, Q11). The token
  exchange and back-channel logout limits move to the shared `auth.rate_limit`
  store, and token exchange gains the IP-plus-client-id bucket that the
  `auth-and-rbac` spec already requires. The `/v1` per-principal limit and the SPA
  fallback stay per replica and are documented as such.
- **An atomic back-channel replay guard** (F6, Q14). A partial unique index on the
  back-channel identifiers of `auth.verification` backs an `on conflict do nothing`
  insert, and the insert and the session delete run in one transaction. The route
  also caches Visma Connect's discovery document and JWKS and bounds `exp - iat`.
- **A pre-purge warning** (G10, Q12). A new daily job, `identity:purge-warning`,
  runs as its own narrow role and emails a fixed notice to an organization's
  administrators 24 to 48 hours before its purge. It sends once per marker, under
  the same notice controls as the deletion notice. It also emits one event per
  marker, which `046` joins against `catalog.audit.org_deletion_requested` to alert
  on a marker that no request created.
- **ACS through a managed identity** (C1, Q13). `@azure/identity` provides the
  credential: a managed identity for the API and the jobs, and the Azure CLI login
  for the operator CLI under PIM. `ACS_CONNECTION_STRING` is removed, and startup
  refuses it if it is set. **BREAKING** for deployment configuration.
- **Telemetry for silent failures** (G12, G13; Q16, Q17). The identity wrapper's
  Cerbos errors get their own event, `identity.internal_error`, and a counter,
  `tayzu.authz.errors`, and no longer count as denials. A rejected
  `/organization/set-active` is logged with the user id only.
- **One public origin, checked at startup** (D7, Q18). Startup fails when the
  origin of `BETTER_AUTH_URL` is not in `ALLOWED_ORIGINS`.

Out of scope, in `046`:

- the IaC and the deployment pipeline;
- every value that depends on the deployed environment: hop counts, CIDRs,
  retention, the Visma Connect production client;
- the Visma Connect test-environment run (F2) and the `sid`/`sub` decision that
  follows it (F5);
- the reset response-time floor measured under staging load (I5);
- the exporter and collector checks (G1, G2), the alerts, the KQL runbook;
- the repointing of the old `010` references.

Also out of scope: Redis, which comes with `004`; the egress allowlist, which stays a
ticket; and Argon2id.

## Capabilities

### New Capabilities

None. Every item hardens a surface that an existing capability already owns
(Q19).

### Modified Capabilities

- `auth-and-rbac`: proxy trust, the migration role and the public-origin check (new
  requirements, Q30); the step-up binding; the shared
  token-exchange and back-channel limits; the atomic replay guard; the versioned
  secrets; the exported decision log; the rejected tenant switch.
- `password-reset-and-account-recovery`: the platform password hash, its cost and
  rehash on sign-in; ACS through a managed identity for the operator CLI.
- `identity-lifecycle-and-org-admin`: the identity wrapper's internal-error signal
  and the managed-identity email sender.
- `org-deletion-and-data-retention`: the pre-purge warning, its job, its role and
  its events.
- `catalog-ui-core`: the CSP report directives and the report endpoint.

## Impact

- **Code**:
  - `packages/db`: the migration runner and the TLS error text.
  - `apps/api`: `config.ts`, `server.ts`, `reauthorization.ts`, the identity
    wrapper, the accept flow, the scripts and the new warning job.
  - `packages/auth`: the password hash, the auth instance options, the email
    adapter, the step-up checks, both telemetry contract modules and the email
    templates.
  - `packages/authz`: the mirrored contract.
  - The OIDC stub fixture.
- **Database**: two migrations, each stopped at ⛔ **Checkpoint 3**:
  - `0016`, the back-channel partial unique index;
  - `0017`, `warned_at` on the deletion marker, plus the warning role with its
    narrow grant and RLS policy.
- **Cerbos**: no policy change. `config/cerbos.production.yaml` is PDP
  configuration, not a policy (Q15).
- **Dependencies**: one, `@azure/identity` `4.14.1` (MIT), with root overrides that keep
  its three msal packages at releases at least 14 days old, named in `design.md`
  with its transitive packages and install-script review. This is the design
  amendment that `043` Q28 asked for.
- **Configuration (BREAKING for deployments)**:
  - new: `MIGRATION_DATABASE_URL`, `TRUST_PROXY_HOPS`, `TRUST_PROXY_CIDRS`,
    `BETTER_AUTH_SECRETS` and `ACS_ENDPOINT`;
  - removed: `BETTER_AUTH_SECRET` and `ACS_CONNECTION_STRING`.
  - No deployed environment exists, so nothing migrates.
- **Telemetry**: new names, all declared in `design.md` before implementation:
  - `tayzu.web.csp_violations`, `tayzu.authz.errors`;
  - `identity.internal_error`, `auth.security.active_organization_rejected`;
  - the reason `session_mismatch`;
  - the warning job's events and counter;
  - new rate-limit scope values.
- **Docs**:
  - a new ADR for the password hash;
  - ADR-0026 point 9;
  - the system diagram (the warning job);
  - under `docs/security/`: `attack-surfaces.md` (clears the pending rows this
    change closes), `secrets.md`, `crypto-inventory.md`, `data-retention.md` and
    `dependencies.md`.
- **Roadmap**: decision D14 in `openspec/project.md` §23, already recorded on
  2026-11-27, and the execution order `003 -> 048 -> 046`.
