# VCDM Agent: SSA Mode A Pre-Assessment of `048-production-hardening` (task 1.1)

Both skill parts were loaded and checked: SEC01 to SEC10 from `SKILL.md`, SEC11 to SEC16
from `SEC11-SEC16.md`. I read `openspec/project.md`, every artifact of this change
(`proposal.md`, `design.md`, `tasks.md`, the five `specs/*/spec.md`), the archived
`002` SSA pre-assessment for the format, the gate sections of the archived `002`, `043`,
`044`, `045` and `003` designs, and every source file the design's Context cites. I also
read the installed `better-auth@1.7.7` and `@better-auth/core@1.7.7` code paths the design
depends on.

**Branch state.** The code on this branch is identical to `origin/master` (`d9913b8`).
Since then the branch has six commits: `df5609d` (roadmap D14), three planning commits
(`ae89a3e`, `5d87352`, `1acd056`), and two that landed while this assessment ran:
`f1d13c2` (task 1.2, `@azure/identity`) and `61bc952` (task 1.3, the warning-job
scaffold). Both are reviewed below. `tasks.md` asks for task 1.1 to run "first", so this
order is a process note, not a finding against the code.

Tooling run (read-only): `pnpm audit --prod --audit-level=high` reports 0 high or
critical findings (5 low, 7 moderate). A `git grep` for secret patterns (ACS access keys,
storage account keys, PEM private keys, GitHub, Slack and AWS tokens, inline
`BETTER_AUTH_SECRET(S)=` values) over the tracked files, excluding fixtures and tests,
finds nothing. I checked the install scripts of the 30 new packages from `f1d13c2`: none
has one.

Skill-to-Tayzu mapping used in this report: VITC and GSOC map to Azure Monitor and the
`046` alerting and on-call path; `teamcity.visma.com` and `octopus.visma.com` map to GitHub
Actions with OIDC federation (Q3); "Visma Privileged User Management" maps to Entra ID PIM.
Visma Connect is Tayzu's primary IdP, so its items apply as written.

## Summary

| Status | Count |
| ------ | ----- |
| COVERED | 45 |
| GAP (blocking) | 1 |
| GAP (non-blocking) | 15 (one of them is the test half of the blocking gap) |
| HUMAN | 4 questions (H1 to H4; H4 covers the SEC01 and SEC16 checklist rows) |

**Blocking gap.** It touches security logging and injection, and it must be resolved or
explicitly deferred before task 9.3:

1. **Unvalidated caller input reaches the Cerbos decision log that D10 exports to Azure
   Monitor.** The catalog pipeline authorizes before it validates the input. Only
   `entity.search` has a `validateInput`. Every other declaration sends the raw input
   string to Cerbos:
   - `inputString(input, 'identifier')` as the resource `id`;
   - `inputString(input, 'blueprint')` as `blueprintId`;
   - the raw `spec.relations.ownerTeam` string as `ownerTeam`.

   `inputString` only checks that the value is a non-empty string. Evidence:
   - `packages/catalog/src/service/pipeline.ts:377-381`, `:526-551`;
   - `blueprints.ts:525`, `:614`, `:678`, `:809`;
   - `entities.ts:1092-1099`, `:1232-1272`, `:1539-1546`, `:1706-1713`, `:1829-1836`,
     `:2005-2012`;
   - `entity-authz-attributes.ts:132-157`.

   Today the decision log stays in a local file in the container. Under D10 it goes to
   stdout, then to Azure Monitor, with the 12 + 24 month security retention of Q4. Any
   authenticated caller, human or agent, can therefore write arbitrary text (personal
   data, log-forging payloads, strings up to the `/v1` body limit) into the security log.

   The D10 spec requirement says these values are "identifiers, roles and enumerated flags,
   never tenant free text". The D10 test and task 9.3 only drive *valid* entities with a
   marker in their title, description and properties. They never put a marker in the
   identifier, `blueprint` or `ownerTeam` fields, and they never check resource or
   principal ids. So the test would pass while the invariant stays broken. This is HUMAN
   question H1.

No fixed Tayzu decision is re-opened. The gap is in how D10 closes the loop around Cerbos
and Azure Monitor.

---

## Per-section table

| Section | Applicability | Item | Status | Evidence or fix |
|---|---|---|---|---|
| SEC01 Diagram | APPLIES. New job, new public route, new token flow, new log path | Warning job and its two database connections, ACS token flow | COVERED | Task 12.9, design D16, SEC01 row. |
| SEC01 | APPLIES | Every SEC02 attack surface is in the diagram under the same name | GAP (non-blocking) | No task adds `POST /v1/csp-reports` (browser to API, HTTPS) or narrows the `reauthApi` node and its arrow. They still say "GET and POST" and "query or form_post" (`docs/architecture/system-diagram.md:66`, `:155`). No task draws the Cerbos decision log path (sidecar stdout, then the ACA log sink, then Azure Monitor). Fix: extend task 12.9 (and `system-diagram.test.ts`) with these three changes, in the full diagram and in each trust-zone block. |
| SEC01 | APPLIES | Supporting systems: identity provider for workload tokens | GAP (non-blocking) | The design's SEC01 row says "No new actor", but the API and the jobs now obtain Entra ID tokens through the managed-identity endpoint, and the operator CLI through `az login`. Today the diagram shows Entra ID only for developers (`:240`). Fix: draw the token arrows (HTTPS) in task 12.9. |
| SEC01 | APPLIES | Open improvement items from the previous year | HUMAN | H4. |
| SEC02 Attack surfaces | APPLIES | New public route documented with actors, authentication, authorization and technology | COVERED | D9 and task 8.7 add the row to `docs/security/attack-surfaces.md`. The route is on `PUBLIC_ROUTE_ALLOWLIST` (task 8.5). |
| SEC02 | APPLIES | Narrowed re-authorization callback | COVERED | D6, tasks 6.5 and 6.6. |
| SEC02 | APPLIES | Administration interfaces get extra protection | COVERED | Operator CLI under PIM with the operator's own identity (D13, password-reset spec "Operator recovery"). |
| SEC02 | APPLIES | Shared API keys anti-pattern | COVERED | The ACS connection string (one key for every sender) is removed and refused (D13). |
| SEC02 | APPLIES | Legacy code anti-pattern | COVERED | The `form_post` callback and its parser are removed (D6). The retired variables are refused at startup (D4, D13). |
| SEC02 | APPLIES | Pending table rows the change closes | GAP (non-blocking, mechanical) | The tasks name the rows by inventory id (B1, D3, F4, G3, D10), but `attack-surfaces.md:684-690` labels them by question number. See Drift-check, row M23. |
| SEC03 Access control | APPLIES | Deny by default on the new route | COVERED | `route-auth-allowlist.int.test.ts` (task 8.5). The route reads no session and grants nothing. |
| SEC03 | APPLIES | Engine outage still fails closed | COVERED | D11, Q28, identity-lifecycle spec. |
| SEC03 | APPLIES | Step-up bound to the browser | COVERED | D6. Single-use state, 256-bit nonce, `response_mode=query`, constant-time session match, nonce verified before the result is stored. |
| SEC03 | APPLIES | Tenant switch rejection visible | COVERED | D12. |
| SEC03 | APPLIES | Warning role: least data, database-stamped write | COVERED | D14, migration `0017`, task 12.1 (Checkpoint 3). |
| SEC03 | APPLIES | D11 covers both the caller check and the target check | COVERED, with a drift note | The target denial records a second `recordAuthzDecision` (`define-operation.ts:226-232`), which the design does not cite. Task 10.2 already names both checks. See Drift-check, row M13. |
| SEC03 | APPLIES | One access-control path (anti-pattern) | COVERED | No new authorization mechanism. |
| SEC04 Password storage | APPLIES | Hashed, salted, OWASP cost, constant-time compare, self-describing format | COVERED | D5, ADR-0028 (task 5.5). |
| SEC04 | APPLIES | Old mechanism after a migration (anti-pattern) | COVERED | Legacy hashes are rewritten on the next sign-in. No second identity path is added. |
| SEC04 | APPLIES | A failed sign-in keeps its timing | GAP (non-blocking) | Better Auth answers an unknown user by running the *configured* `password.hash` (`better-auth/dist/api/routes/sign-in.mjs:321,328`). After D5, that is the new hash: `N=2^15, r=8, p=3`, cost ∝ `N·r·p` = 786k. A user with a legacy hash who gives a wrong password is checked with `N=16384, r=16, p=1`, cost 262k. The failure is about 3 times faster, which reveals the account exists. The same oracle comes back at every future cost increase (`needsRehash` on lower platform parameters). Task 5.4 compares a legacy failure with "as before", not with an unknown user. Nothing is exploitable today because no deployed hash exists. This is HUMAN question H2. |
| SEC04 | APPLIES | Legacy comparison uses `===` | GAP (non-blocking, residual) | Legacy verification still goes through `@better-auth/utils@0.4.2`, which compares derived keys with `===`. The leak is about the derived key, not the password, and no legacy hash will exist in production (F8 gate). Fix: state it in ADR-0028 as residual. |
| SEC05 Crypto | APPLIES | Algorithms, key lengths, key storage listed | COVERED | `crypto-inventory.md` updates (tasks 5.5, 11.5). Versioned secrets (D4). |
| SEC05 | APPLIES | Every encryption in Better Auth follows `secretConfig` | COVERED (verified) | Checked in `better-auth@1.7.7`: the TOTP secret (`two-factor/index.mjs:135`), backup codes (`backup-codes/index.mjs:291,330`), OAuth tokens (`oauth2/utils.mjs:22`), the JWKS private key (`jwt/utils.mjs:54`, `sign.mjs:61`) and the OAuth state (`state.mjs:64`) all use `ctx.context.secretConfig`, so D4's rotation claim holds. |
| SEC05 | APPLIES | Every Tayzu consumer of the signing secret | GAP (non-blocking, mechanical) | D4 lists two consumers. There is a third: `packages/auth/src/auth.ts:1640-1643` reads the session cookie with `ctx.context.secret` to tell a step-up from a login. It follows the same rule. Add it to D4 and to task 4.3's assertions. |
| SEC05 | APPLIES | TLS posture of new connections | COVERED | D1 (migration URL), D14 (warning URL), `sslmode=verify-full`. The SSL Labs check of the public ingress stays a `046` gate (`attack-surfaces.md:684`). |
| SEC05 | APPLIES | No custom or obsolete algorithm | COVERED | scrypt from `node:crypto`, `timingSafeEqual`, `randomBytes`. No custom primitive. |
| SEC06 Misuse | APPLIES | Spoofed forwarded addresses | COVERED | D2. Peer CIDR plus hop count. The `proxy-addr` walk was checked against all three spec scenarios. |
| SEC06 | APPLIES | Double back-channel delivery and replay | COVERED | D8, migration `0016`, one transaction. |
| SEC06 | APPLIES | CSP report flood, hostile bodies | COVERED | D9. 8 KiB limit before parsing, null-prototype parse, 204 always, budget, no log per report. |
| SEC06 | APPLIES | Memory bound of the in-process CSP report bucket | GAP (non-blocking) | D9 says "an in-process per-address bucket" without a size bound. An IPv6 sender can rotate addresses to grow the map. Fix: say in D9 that the bucket uses `@fastify/rate-limit`'s LRU-bounded store (as the SPA fallback does) or another explicit cap, and add a case to task 8.5. |
| SEC06 | APPLIES | `application/json` to `/v1/csp-reports` answers 415 | GAP (non-blocking, design gap) | The `/v1` media-type hook (`server.ts:767-790`) accepts `application/json` everywhere, and the route scope inherits Fastify's JSON parser. Nothing in D9 makes `application/json` answer 415, which the scenario "Other media types are refused like any `/v1` body" requires. Fix: in D9, have the route scope refuse every media type except its two, with the hook's exact 415 body. |
| SEC06 | APPLIES | Cost of the stronger scrypt on a public route | GAP (non-blocking, ticket) | `p=3` runs sequentially on the libuv thread pool (4 threads by default). The per-IP and per-email limits do not bound a distributed sign-in or unknown-user flood, which can now hold the pool about 3 times longer and starve other thread-pool work. Proposed ticket: a global concurrency cap on password hashing and an explicit `UV_THREADPOOL_SIZE`, with `046` load evidence. |
| SEC06 | APPLIES | Client-id bucket lets anyone exhaust a known integration's budget | COVERED (accepted, Q21) | Stated in Risks. Not re-opened. |
| SEC06 | APPLIES | Dynamic raw SQL (anti-pattern) | COVERED | Every new statement in D1, D5, D8 and D14 is parameterized. `sql.raw` stays banned. |
| SEC06 | APPLIES | Log injection through authorization inputs | **GAP (BLOCKING)** | Blocking gap 1. |
| SEC06 AI | PARTIAL | AI-specific misuse | COVERED (N/A in scope) | No AI component in this change. Actor parity is unchanged. |
| SEC07 Dependencies | APPLIES | New dependency reviewed: license, age, install scripts, single `core-auth` copy, SBOM | COVERED | `f1d13c2`, `docs/security/dependencies.md` "Azure credentials for email delivery". Audit at high is clean (run here). |
| SEC07 | APPLIES | Root `pnpm.overrides` for `@azure/msal-*` | GAP (non-blocking, mechanical) | `f1d13c2` adds three root overrides (`msal-browser 5.29.1`, `msal-common 16.16.2`, `msal-node 7.2.2`) to meet the 14-day rule (`003` Q43). Design D13 and the proposal still say "one dependency" and never mention overrides, and an override can hold back a security fix. Fix: name the overrides and their removal trigger in D13. |
| SEC07 | APPLIES | Unused components (`open`, `msal-browser` and its platform helpers in a server image) | COVERED (accepted) | Risks in D13. Only `ManagedIdentityCredential` and `AzureCliCredential` are imported. |
| SEC08 File upload | N/A | The CSP report body is parsed, not stored | COVERED (justified) | No upload, no file storage. |
| SEC09 Secrets in code | APPLIES | Review done | COVERED | `git grep` done here (see above). The CI `gitleaks` job is unchanged. |
| SEC09 | APPLIES | Every holder of the retired variables is changed | GAP (non-blocking, mechanical) | Task 4.1 names `e2e.sh`, `dast.sh` and "the test fixtures". It does not name `scripts/ci/zap-seed.ts:85,183`, which reads `BETTER_AUTH_SECRET` and forwards it to `bootstrap-admin`, nor `scripts/ci/dast.sh:309` (`BETTER_AUTH_SECRET=unused`). Under D4 the bootstrap would then refuse to start. Task 11.1 does not name `packages/auth/scripts/acs-email-smoke.ts` (`ACS_CONNECTION_STRING`; see H3) or the bundle-check fixture `apps/web/src/build-check/__fixtures__/secrets.md`. |
| SEC10 Secret management | APPLIES | Inventory, location, confidentiality, rotation | COVERED | D4 runbook, D16 `secrets.md` rows, the `config.test.ts:225-232` table assertion. |
| SEC10 | APPLIES | Managed identities preferred over stored secrets | COVERED | D13 removes the ACS key. |
| SEC10 | APPLIES | Better Auth's own parser echoes the secret | COVERED (verified) | `parseSecretsEnv` (`better-auth/dist/context/secret-utils.mjs:18`) puts the whole entry, secret value included, in its error message. It only runs when `options.secrets` is absent (`create-context.mjs:70`). D4 always passes `secrets`, and Tayzu's own parser runs first in `loadConfig`. Keep task 4.2's ambient-variable test. It is the guard. |
| SEC10 | APPLIES | The warning job holds `tayzu_auth` and the notice HMAC key | COVERED (accepted, Q23) | Residual: a broad cross-tenant role in a daily job. Proposed ticket: a narrow notice-recipient role. |
| SEC11 Phishing | PARTIAL | Fixed template, purge date only, no link, recipient cap, kill switch, rate caps | COVERED | D14, org-deletion spec "The warning carries no free text". |
| SEC11 | PARTIAL | Q5 "content based on user input" | COVERED | No interpolated tenant text. The date format and time zone are fixed by the template. |
| SEC12 Testing | APPLIES | Security controls have scenario tests; DAST covers the new route | COVERED | D15, task 8.6 (Q29). Proxy-trust spoofing matrix, concurrency tests, marker-leak tests. |
| SEC12 | APPLIES | The D10 marker test misses the fields that carry the risk | GAP (fix of blocking gap 1) | Extend task 9.3: hostile `identifier`, `blueprint` and `ownerTeam` values, and assertions on resource and principal ids as well as attributes. |
| SEC12 | APPLIES | Migration refusal list can drift from the roles migrations create | GAP (non-blocking) | `RUNTIME_DATABASE_ROLES` is a hand-kept list (D1). Fix: a `packages/db` integration test that every `LOGIN` role created by `migrations/` other than `tayzu_migrator` is in the list, so a future job role cannot migrate. |
| SEC12 | APPLIES | Post-launch monitoring (Q3) | COVERED (deferred) | The alerts on `identity.internal_error`, `tayzu.authz.errors`, repeated `active_organization_rejected`, CSP trends, orphan markers and the missed warning run are `046` gates. |
| SEC13 Deployment | PARTIAL | Production Cerbos file reviewed and tested here, mounted by `046` | COVERED | D10, tasks 9.1 and 9.2. Image pinned by digest. |
| SEC13 | PARTIAL | Decision-log metadata | GAP (non-blocking) | D10 does not say whether the production audit block includes request metadata (`includeMetadataKeys` and `excludeMetadataKeys`). Fix: set them explicitly in both files (so the equality rule holds) and assert in task 9.1 that no metadata key is logged. |
| SEC13 | PARTIAL | No deployment from a developer machine (anti-pattern) | COVERED | The operator CLI runs only from the production-network operator environment under PIM (spec "Operator recovery"). |
| SEC14 Infra permissions | APPLIES | Migration role separated from the runtime roles | COVERED | D1 refuses every runtime role. `046` provisions `tayzu_migrator`. |
| SEC14 | APPLIES | New role least privilege | COVERED | `0017`: column-level `SELECT`/`UPDATE`, two RLS policies, `NOBYPASSRLS`, no `SET ROLE` path, purge role unchanged (Checkpoint 3). |
| SEC14 | APPLIES | Azure role for ACS sending | GAP (non-blocking, `046` gate) | D13 leaves "the role that sends email" to `046`. Built-in Owner and Contributor roles on the ACS resource grant management-plane rights. Fix: add to the C1 gate that `046` assigns the narrowest role that allows `send` only (a custom role if needed) to the API identity, the job identities and the PIM group, and records it. |
| SEC15 Network and host | PARTIAL | No new listener; proxy trust bounded; values from the deployment | COVERED | D2. `046` sets and verifies the values. New egress to the managed-identity endpoint and Entra ID joins the existing egress-allowlist ticket. |
| SEC16 Logging | APPLIES | New security events, sampling-exempt, opaque ids and enums only | COVERED | Observability contract: four events, three counters. |
| SEC16 | APPLIES | Authorization engine decision log centralized | COVERED once blocking gap 1 is closed | D10, G3 gate, Q4 retention. |
| SEC16 | APPLIES | Integrity: logs leave the host | COVERED | Cerbos goes from a container-local file to stdout and Azure Monitor (D10). Fixes the "locally stored logs" anti-pattern. |
| SEC16 | APPLIES | Open improvement items from the previous year | HUMAN | H4. |

## Proposed improvement tickets

1. **(BLOCKING, D10)** Shape-guard every value sent to Cerbos (resource id, `blueprintId`,
   `ownerTeam`, principal id), and extend task 9.3 to hostile values (H1).
2. Update the system diagram: `POST /v1/csp-reports`, the GET-only callback, the Cerbos
   decision-log path, and the workload-token arrows to Entra ID (task 12.9 plus
   `system-diagram.test.ts`).
3. Equalize the failed-sign-in cost for weaker stored hashes (H2), or document the
   residual in ADR-0028.
4. Bound the CSP report bucket's memory (D9, task 8.5).
5. Make `application/json` on `/v1/csp-reports` answer the `/v1` 415 (D9, task 8.5).
6. Add a global concurrency cap on password hashing and an explicit `UV_THREADPOOL_SIZE`,
   with load evidence in `046`.
7. Add a drift test: every `LOGIN` role created by the migrations is in
   `RUNTIME_DATABASE_ROLES`.
8. Set the decision-log metadata keys explicitly and assert that no metadata key is logged
   (task 9.1).
9. Add the least-privilege ACS sending role to `046`'s C1 gate.
10. Add a narrow notice-recipient database role, so that the warning job and the request
    path no longer need all of `tayzu_auth` (`Q23` residual).
11. Already in the design and carried here: prune `auth.rate_limit`, which is now more
    urgent because two new scopes write on unauthenticated routes. Recommend adding it to
    `046`'s gates as a precondition of the first deployment rather than leaving it a
    ticket. Also carried: cache the re-authorization verifier's keys, internal-error events
    for repository failures, and a shared store for the `/v1` and SPA budgets.

## Questions for the human

These are not answered here. The orchestrator asks each one in chat and records the
answer as a Resolved decision from Q32 on.

**H1. (Blocking gap 1) How should caller input be kept out of the exported Cerbos decision log?**

1. In `authorize()` of `pipeline.ts`, and in the entity referrer check, replace with the
   fixed `_`, before the Cerbos call:
   - any resource id that does not match its identifier pattern;
   - any `blueprintId` or `ownerTeam` value that does not match its identifier pattern.

   The handler's own validation still rejects the input afterwards, with the same answer as
   today. A `_` blueprint or team matches no grant, so the change fails closed. There is no
   policy change and no new error ordering. Task 9.3 is extended to hostile values and to
   ids. **(Recommended)**: it closes the log-injection path at the one place every catalog
   check passes, without changing any answer or the authorize-before-validate order
   (which hides validation detail from unauthorized callers).
2. Validate the identifier fields in a `validateInput` before authorization, so that a
   malformed identifier answers `CATALOG_VALIDATION_FAILED` before `AUTH_FORBIDDEN`. This
   changes the answer order for unauthorized callers and needs a catalog-core spec delta.
3. Defer: keep D10 as designed, record the residual (arbitrary caller text in the security
   log, protected only by Azure Monitor access control) and open a ticket.

**H2. (SEC04) A failed sign-in against a weaker stored hash is faster than an unknown user's.**

1. In `verifyPassword`, when a legacy or lower-cost hash fails to verify, also run one
   current-cost `hashPassword` and discard it. A failed sign-in then costs the same as an
   unknown user, now and at every later cost increase. Task 5.4's enumeration test
   compares a legacy failure with an unknown user. **(Recommended)**: it is cheap, it only
   runs on failures, and it keeps the spec's "MUST NOT change the timing" true across
   upgrades.
2. Keep D5 as is and record the oracle in ADR-0028 as a residual, since no deployed hash
   is in the legacy format.
3. Drop legacy-format verification entirely, since nothing is deployed (this reverses part
   of Q8).

**H3. (D13 drift) `packages/auth/scripts/acs-email-smoke.ts` builds the real ACS client
from `ACS_CONNECTION_STRING`, but D13 says `@tayzu/auth` gains no `@azure/identity`
dependency.**

1. Move the smoke script to `apps/api/scripts/`. There it builds an `AzureCliCredential`
   (the operator's own login, as `recover-admin-mfa` does) and uses the injected-credential
   adapter, and task 11.4 covers it. **(Recommended)**: it keeps `@tayzu/auth`
   dependency-free and offline-testable, and it keeps a manual real-send check that does
   not need a secret.
2. Delete the smoke script. `046`'s sandbox step is the only real-token check.
3. Add `@azure/identity` as a `devDependency` of `@tayzu/auth` for the script only.

**H4. (SSA checklists, SEC01, SEC03, SEC07, SEC13, SEC16) "You have verified and updated
any open improvement items from the previous year".** Only the human can confirm this. The
carried tickets are the ones in the `002`, `043`, `044`, `045` and `003` designs and in
this design's Tickets.

1. They are reviewed in `046`'s full SSA, the first deployed assessment. `048` only states
   which of them it closes (C1, C2, D3, B1, F4, F6, G3, G10, G12, G13). **(Recommended)**:
   `048` deploys nothing, and `046` is where the open items meet the real environment.
2. They are reviewed now, and each ticket's state is recorded in this report before task
   2.1 starts.
3. Both: a short state check now, and the full review in `046`.

---

## Drift-check of the design's Context and Decisions (task 1.1)

Scope: every file and line the design cites, checked against this branch. This branch's
code equals `origin/master` `d9913b8`, plus `f1d13c2` and `61bc952`, which touch only
`apps/api/package.json`, root `package.json`, `pnpm-lock.yaml`,
`apps/api/scripts/purge-warning-job.ts`, `apps/api/src/scripts-smoke.test.ts` and docs.

The rows below are mechanical. The orchestrator applies the corrections to `design.md`
(Context) and `tasks.md`. This agent is read-only and changed neither.

| # | Reference in the design or tasks | Result | Correction |
|---|---|---|---|
| M1 | Context "repository at `ae89a3e`" | Code identical; branch moved | Say "code at `origin/master` `d9913b8`; tasks 1.2 (`f1d13c2`) and 1.3 (`61bc952`) landed before 1.1". |
| M2 | `packages/db/src/run-migrations.ts:9-22`; `connection-security.ts:52-53` | Match | — |
| M3 | `turbo.json:43-46` | Match | — |
| M4 | `scripts/ci/e2e.sh:224-233`, `scripts/ci/dast.sh:168-204` | Match (exports at 227 and 172, migrate at 233 and 204) | Add `dast.sh:309` (`BETTER_AUTH_SECRET=unused` for `zap-seed.ts --refresh`) and `scripts/ci/zap-seed.ts:85,183` (reads `BETTER_AUTH_SECRET` and forwards it to `bootstrap-admin`) to D4 and to task 4.1's file list. |
| M5 | `apps/api/src/bootstrap.ts:25-33` | Function is 25-38 | `:25-38`. |
| M6 | `server.ts:665-670` (trust proxy) | Match | — |
| M7 | `server.ts:978-1033` (callback GET and POST, form parser) | Shifted | `:979-1036` (parser 1002-1014, GET 1027, POST 1031). |
| M8 | `server.ts:276-309` (CSP), `:91`, `:432` | Match | — |
| M9 | `server.ts:946-958` (back-channel limiter); `:1046-1063` (token exchange) | First matches; second ends at 1066 | `:1046-1066`. |
| M10 | `server.ts:879-920` (replay insert and deletes) | Shifted by 1 | `:880-921`. |
| M11 | `reauthorization.ts:1-11,168-271`; `:181-186` (pending bound by prefix) | First is fine; the prefix match is at 183 and 191 inside the statement 177-194 | `:177-194`. |
| M12 | `auth.ts:216-223`, `:986-997`, `:1446-1459`; `:1320-1330` (set-active snapshot); `:1470-1485` (reset-race check) | First three match | `:1314-1330`; `:1470-1488`. |
| M13 | `define-operation.ts:145-170,186-191` | Match | Add the target-check path `:200-244` (second `recordAuthzDecision` at 226-232), which D11 also changes. |
| M14 | `accept-flow.ts:281-294` | Match (`try` spans 271-294) | — |
| M15 | `@better-auth/core` `init-options.d.mts:517-532`; `create-context.mjs:70-81`; `cookies/index.mjs:109,157,172` | Match (the file is `dist/types/init-options.d.mts`) | Path prefix `dist/types/`. Cookie signing also at 168 and 177. |
| M16 | D4 "Tayzu's own consumers": `pre-auth-rate-limit.ts:309`, `identity/reset-factor.ts` | Match, but incomplete | Add `packages/auth/src/auth.ts:1640-1643` (`getSignedCookie(..., ctx.context.secret)`). |
| M17 | `config.ts:443-446`, `:333-367`, `:242-258`, `:266-295`; `script-config.ts:16,47,120`, `:22,57,76` | Match | `:242-259`. `script-config.ts` also `:83,88` (`ACS_REQUIRED`). |
| M18 | `azure-communication-email.ts:56-82,115-127` | Match | Add `packages/auth/scripts/acs-email-smoke.ts` (connection string, see H3) and the bundle-check fixture `apps/web/src/build-check/__fixtures__/secrets.md` to D13 and task 11.1 or 11.5. |
| M19 | `0002_auth_schema.sql:150`; `0012`, `0013`; journal ends at idx 15 (`0015_catalog_entity_search`) | Match | — |
| M20 | `harness.ts:241-300`; `config.test.ts:225-232`; `password-reset-confirm.ts:295`; ADR-0025:65; `token-exchange.ts` one hour (`:114`) | Match | — |
| M21 | `config/cerbos.yaml:21-27` (audit block) | Shifted by 1 | `:22-28`. Its header comment (lines 6-8) cites a stale "task 7.2"; task 9.4 rewrites it. |
| M22 | Gate inventory ranges `002:1334-1358`, `043:3632-3717`, `044:1417-1460`, `045:914-949`, `003:1167-1194`; `002:1324`, `002:1329`, `002:270-276` | Match, except `002` has 1357 lines | `002:1334-1357`. |
| M23 | Tasks 2.4, 3.5, 6.6, 7.8 and 9.4 name Pending rows of `attack-surfaces.md` by inventory id | The table labels rows by question | B1 = "`MIGRATION_DATABASE_URL` wiring (Q58)" (:686); D3 = "Configurable `TRUST_PROXY` (Q58)" (:687); F4 = "SSO step-up callback bound to the browser (Q71)" (:688); the replica half of D10 and F6 = "Back-channel logout and replicas (Q73)" (:689); G3 = "Cerbos audit log (Q58)" (:690). Row :685 (Q57) still names the `form_post` callback, which F4 makes obsolete. The "Client address" row (:97) and line 371 also name `TRUST_PROXY`. |
| M24 | Test files named without a path, or as existing | Paths differ | `check-bundle.test.ts` is `apps/web/src/build-check/check-bundle.test.ts`. "The digest of `authz-pipeline.int.test.ts`" is `packages/catalog/src/service/authz-pipeline.int.test.ts`. `pre-auth-rate-limit.int.test.ts` exists twice (`apps/api/src/`, `packages/auth/src/`), and task 3.3 means the `apps/api` one. New files, which is expected: `packages/db/src/run-migrations.test.ts`, `run-migrations.int.test.ts`, `connection-security.test.ts`, `packages/auth/src/sso/backchannel-logout.test.ts`. |
| M25 | D10 "the identity wrapper sends ... `tenantId`, `blueprintId`, `accountKind`" | `blueprintId` is catalog-only; the identity wrapper's principal carries `tenantId` only | Replace with the inventory below. |
| M26 | D13 "one dependency" | `f1d13c2` also adds three root `pnpm.overrides` | Name them in D13 (see SEC07). |
| M27 | D16 docs list | Incomplete | Also update ADR-0016:98 (`BETTER_AUTH_SECRET`), ADR-0023:58 ("Better Auth's exported password hash function") and ADR-0023:103 (`BETTER_AUTH_SECRET`) with a short "amended by `048`, ADR-0028" note, and the system-diagram nodes of SEC01 above. |

No scope or design conflict comes out of the drift-check, except H3 (the smoke script).

## Cerbos attribute key inventory (design D10)

There are six non-test callers on this branch: five `checkResources` and one
`planResources`. No other caller exists in `apps/` or `packages/` (`git grep`).
`buildAttributes` (`packages/authz/src/attributes.ts`) always sets `tenantId` first from
the trusted context, and drops any `tenantId` in `extra`.

### Principal attributes

| Key | Value shape | Sent by |
|---|---|---|
| `tenantId` | organization id (opaque) | all six callers |
| `teams` | array of team identifiers | catalog pipeline `authorize()` (`pipeline.ts:404-411`), entity list plan (`entities.ts:334-340`), referrer update check (`entities.ts:983-990`), redaction (`packages/authz/src/redaction.ts:44-51`) |
| `moderatedBlueprints` | array of blueprint identifiers | the same four callers |

The identity wrapper (`define-operation.ts:153-158`) and the accept flow
(`accept-flow.ts:281-286`) send `tenantId` only.

Principal ids: the actor id (opaque), or the inviter's user id in the accept flow.
Principal roles: the closed role names (`admin`, `member`, ...).

### Resource attributes

| Key | Value shape | Resource kinds and sources |
|---|---|---|
| `tenantId` | organization id | every resource of every caller |
| `blueprintId` | blueprint identifier. **Today the raw input string** (blocking gap 1) | `catalogEntity`: every entity declaration (`entities.ts:1099`, `:1239-1242`, `:1262`, `:1272`, `:1546`, `:1713`, `:1836`, `:2012`) and the referrer check (`:997`, stored value) |
| `createdBy` | actor id | `catalogEntity`, from `loadEntityAuthzAttributes` (stored) or `newEntityAuthzAttributes` (`ctx.actor.id`) (`entity-authz-attributes.ts:58-66`) |
| `locked` | boolean | `catalogEntity` (coerced to a boolean: `=== true` or an inherited owner) |
| `ownerTeam` | team identifier. **Raw `spec.relations.ownerTeam` string on create and upsert** (blocking gap 1); stored value otherwise | `catalogEntity` |
| `accountKind` | `service` or `standard` (or the stored `_user` value) | identity `user`, `serviceAccount` and `organization` resources (`identity-attributes.ts`, `define-operation.ts:175-176,211`); never on `credential` |
| `memberRole` | the target's raw tenant role string | identity `user` targets only |
| `portRole` | role name | identity targets, when the resolver read one |
| `moderatedBlueprints` | array of blueprint identifiers | identity targets, when the resolver read one |

`catalogBlueprint` resources carry `tenantId` only. The redaction batch
(`redaction.ts:52-60`) carries `tenantId` plus the candidates' attributes. Both of today's
callers pass none (`blueprints.ts:227-238`, `entities.ts:927-939`). The accept flow's
`user` resource carries `tenantId` only.

### Resource ids, which the decision log also records

| Id | Source |
|---|---|
| fixed `new`, `list`, `_` | identity, catalog list, create |
| the redaction position (`"0"`, `"1"`, ...) | redaction |
| the masked `_user` placeholder | `_user` entities (`maskUserIdentifier`) |
| the identity target's opaque user id | identity targets |
| **the raw input `identifier`** | blueprint and other entity operations (blocking gap 1) |

Entity identifiers allow `@` and `.` (`ENTITY_IDENTIFIER_PATTERN`), so a non-`_user`
blueprint keyed by email can still put an email in the decision log even after
validation. That is consistent with the existing `catalog.audit.*` attributes, which carry
the same identifiers. It is noted as residual, not as a gap.

### Proposed constants for task 9.3

- `CERBOS_PRINCIPAL_ATTRIBUTE_KEYS = ['tenantId', 'teams', 'moderatedBlueprints']`
- `CERBOS_RESOURCE_ATTRIBUTE_KEYS = ['tenantId', 'blueprintId', 'createdBy', 'locked', 'ownerTeam', 'accountKind', 'memberRole', 'portRole', 'moderatedBlueprints']`
