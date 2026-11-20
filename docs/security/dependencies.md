# Dependency and supply-chain security policy

This document is the policy behind `.github/dependabot.yml`,
`.github/workflows/ci.yml` and the `pnpm.auditConfig` field of the root
`package.json`. It resolves R7 and R14 of
`openspec/changes/archive/2026-09-28-001-catalog-core/design.md` (task 1.7) and covers SEC07 of
the SSA.

## Automated updates

Dependabot opens weekly pull requests for three ecosystems
(`.github/dependabot.yml`):

- **npm**, root directory. Minor and patch updates are grouped into a single
  pull request so routine bumps do not create update noise; a major update
  still opens its own pull request for review.
- **github-actions**, root directory. Every action pinned in `ci.yml`, in
  `identity-maintenance.yml` (`azure/login`, change `045`) and in the
  composite action under `.github/actions/setup/` is covered.
- **docker**, directories `/` and `/scripts/ci`. It reads `compose.yaml` and
  `scripts/ci/Dockerfile.images`, so the pinned image digests below are
  bumped by pull request (task 13.12).

Every entry has a 14-day `cooldown` (`default-days: 14`, `003` Q43 and Q49):
Dependabot does not propose a release until it is at least 14 days old, the
same rule that picks the pinned versions by hand. It applies to all three
ecosystems, not only npm, because the 14-day rule is not npm-specific.
`apps/api/src/dependabot-config.test.ts` asserts it.

### Pinned image digests

| Image                     | Pinned in                                                                            | Tracking mechanism                                                | Owner    |
| ------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | -------- |
| `postgres:18`             | `scripts/ci/Dockerfile.images` (read by `dast.sh`), `ci.yml` services                | Dependabot `docker`, `/scripts/ci`; `ci.yml` copy updated by hand | Platform |
| `ghcr.io/cerbos/cerbos`   | `compose.yaml`, `ci.yml`, `scripts/dev/start-cerbos.sh`, `scripts/policy-compile.sh` | Dependabot `docker`, `/`; the other copies updated by hand        | Platform |
| `ghcr.io/zaproxy/zaproxy` | `scripts/ci/Dockerfile.images` (read by `dast.sh`), `ci.yml` `docker_name`           | Dependabot `docker`, `/scripts/ci`; `ci.yml` copy updated by hand | Platform |

`apps/api/src/dependabot-config.test.ts` fails when a digest is pinned only
where no `docker` entry reads it.

The PostgreSQL major version follows
[ADR-0024](../adr/0024-postgresql-tracks-latest-azure-ga-major.md): the latest
major that Azure Database for PostgreSQL Flexible Server offers in GA (18
today). Digest bumps within that major are routine. A pull request that moves
`postgres` to a new major is merged only once Azure offers that major in GA,
together with `compose.yaml`, the sandbox's SessionStart hook and the docs.

Runtime-coupled versions are held on purpose. `@types/node` stays on the
major version of the Node runtime (22), so Dependabot ignores its major
updates (`.github/dependabot.yml`); moving to a new Node major is an
explicit decision that updates the runtime, `engines` and these types
together.

`@playwright/test` and `playwright-core` are ignored for every update type
(`003` Q43). The pin (1.63.0) matches the Chromium revision preinstalled in
the sandbox (`/opt/pw-browsers`, revision 1243), so a bump moves the sandbox
browser, CI and the pin together, by hand.

## Fix SLA

Once an advisory is confirmed against Tayzu's dependency graph:

| Severity | Time to fix |
| -------- | ----------- |
| Critical | 7 days      |
| High     | 30 days     |

Moderate and low advisories are tracked but do not carry a fixed SLA; they
are fixed opportunistically or with the next Dependabot update.

## CI enforcement

- **`pnpm audit --prod --audit-level=high`** (`dependency-audit` job) blocks
  the pipeline on any high or critical advisory in a production dependency.
  Dev-only dependencies are excluded (`--prod`) so a fix does not need to wait
  on, for example, a linter's transitive advisory.
- **`pnpm audit --audit-level=critical`** (second step of the same job,
  `continue-on-error: true`) covers every dependency, dev included, so the
  build chain (Vite, Tailwind, the lint and test tools) is audited too
  (`003` design D3). It is **non-blocking**: a critical finding is reported
  in the job log and fixed under the SLA above, but it does not fail the
  pipeline. `pnpm ci:local` runs it as an advisory step that prints a
  `WARNING` and does not fail the run.
- **Semgrep OSS** (`semgrep` job) runs the `p/typescript`, `p/nodejs` and
  `p/secrets` registry rulesets and blocks on `ERROR` severity. `--config auto`
  is never used: it requires a Semgrep login and sends telemetry that this
  project does not want in CI.
- **Syft** (`sbom` job) generates an SPDX JSON SBOM of the pnpm dependency
  tree on every run and uploads it as the `sbom-spdx` workflow artifact. The
  steps are **blocking**, with no `continue-on-error`: a SBOM generation
  failure fails the job. Only an unsupported platform or an unreachable
  download is a skip, as for the other pinned tools.

`RA-AZ` L426-L430 documents code analysis integrated into the CI pipeline as
the standard placement for SAST; `VULN` L190-L196 argues for risk-based
severity thresholds over an all-or-nothing block, which is why the audit gate
is scoped to `high` and above rather than every advisory, and for "controlled
escape hatches with clear audit trails" instead of an unreviewable exception,
which is the shape of the waiver path below. `VULN` L224 names Syft
specifically for baseline SBOM generation.

## Quarterly EOL review

Every quarter, review the support window of Node.js, PostgreSQL and the
libraries below, and record the outcome as a new row. A component past its
vendor's EOL date is a blocking finding for the next `openspec change` that
touches it.

| Component   | Current version | Support / EOL reference                                                                       |
| ----------- | --------------- | --------------------------------------------------------------------------------------------- |
| Node.js     | 22 (LTS)        | Active LTS; check `nodejs.org/en/about/previous-releases`                                     |
| PostgreSQL  | 16              | Check `postgresql.org/support/versioning`                                                     |
| TypeScript  | ~6.0.3 (pinned) | Pinned for typescript-eslint compatibility (root `CLAUDE.md`); re-check the pin every quarter |
| Drizzle ORM | ^0.45.3         | Actively maintained; no published EOL                                                         |
| re2js       | ^2.8.7          | Actively maintained; no published EOL                                                         |
| Ajv         | ^8.20.0         | Actively maintained; no published EOL                                                         |

| Review date                                                             | Reviewer | Outcome |
| ----------------------------------------------------------------------- | -------- | ------- |
| _(none yet — first review is due one quarter after this change merges)_ |          |         |

## License review before adopting a dependency

Before adding a dependency that is not already in the lockfile, check its
declared license.

**Allowlist (OSI-approved, adopt freely):** MIT, Apache-2.0, BSD-2-Clause,
BSD-3-Clause, ISC, 0BSD, Python-2.0, CC0-1.0, MIT-0, BlueOak-1.0.0, Unlicense
(the last three added by `003` Q50).

**Data-only CC-BY-4.0 (accepted, `003` Q50):** CC-BY-4.0 is accepted for a
development dependency that only carries data, such as `caniuse-lite` (browser
support tables under Babel and `browserslist`), and never ships in the web
bundle or the API image.

**Test-only and lint-only MPL-2.0 (accepted, `003` Q26 and Q40):** MPL-2.0 is
an OSI-approved, file-level weak copyleft license. It is accepted only for a
development dependency that never ships in the web bundle or the API image and
that Tayzu does not modify: today `axe-core` (pulled in by
`eslint-plugin-jsx-a11y` for lint, and by `@axe-core/playwright` for e2e) and
`@axe-core/playwright` itself. Build-only use is accepted on the same terms
(`003` Q50): `lightningcss`, which Vite and Tailwind run to compile CSS at build
time and which never ships. A runtime MPL-2.0 dependency, or a modified copy,
still needs a decision in chat.

**Flag for review (source-available, not OSI-approved):** SSPL, BSL / Business
Source License, Elastic License 2.0, and any other license that restricts
running the software as a competing service. A dependency under one of these
licenses is not rejected automatically, but it is never adopted silently: ask
in chat per `openspec/project.md` §20, with the license terms and at least one
OSI-approved alternative, before it is added.

`SOV` L266-L302 documents the open-core and license-change pattern (Elastic's
SSPL move, MongoDB's AGPL-to-SSPL move, HashiCorp's BSL) as a real and
accelerating trend, not a hypothetical: the practical conclusion it draws is
that licenses must be audited before adoption and monitored for later changes,
which is the rule above.

## Overrides

`pnpm.overrides` in the root `package.json` forces a patched version of a
transitive dependency when the direct dependency has not picked it up yet. It
is preferred over a waiver because it removes the vulnerable code instead of
accepting it. Each override is listed here and removed once every path in the
graph resolves to a patched version on its own.

| Override                                    | Advisory            | Path                                                    | Added      |
| ------------------------------------------- | ------------------- | ------------------------------------------------------- | ---------- |
| `@esbuild-kit/core-utils>esbuild` `^0.25.0` | GHSA-67mh-4wv8-2f99 | `drizzle-kit > @esbuild-kit/esm-loader > core-utils`    | 2026-09-28 |
| `source-map-js` `^1.2.2`                    | GHSA-68fv-2mgg-jv7q | `better-auth > vitest > vite > postcss > source-map-js` | 2026-10-08 |

The `source-map-js` path enters through `vitest`, an optional peer of Better
Auth that is test tooling and is not loaded at runtime; the override still
fixes it so the `dependency-audit` job stays green without a waiver.

## Peer dependency rules

`pnpm.peerDependencyRules.allowedVersions` in the root `package.json` accepts
a peer version that a package does not declare yet. JSON holds no comments, so
each entry and its reason are listed here, and the entry is removed once the
package declares the peer itself.

| Entry                                       | Reason                                                                                                                                                                                                                                | Added      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `eslint-plugin-jsx-a11y@6.10.2>eslint` `10` | 6.10.2, the latest release, declares ESLint peers only up to 9 and the repository runs ESLint 10. The human accepted the entry over dropping the plugin or pinning ESLint 9, with a lint test that proves its rules fire (`003` Q40). | 2026-11-19 |

## Security updates

Updates made because `pnpm audit --prod --audit-level=high` reported an
advisory. Each one moves to the first patched release, the smallest change that
removes the vulnerable code, and the full test suite runs against it.

| Date       | Package                                                                        | From → to       | Advisory                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-15 | `better-auth`, `@better-auth/api-key`, `@better-auth/drizzle-adapter` (pinned) | 1.7.6 → 1.7.7   | GHSA-965c-763c-88jm (critical, OAuth state used as a magic link), GHSA-r4xp-prcw-77qf (high, OAuth Proxy sign-in as another user) |
| 2026-11-15 | `zod`                                                                          | ^4.6.5 → ^4.6.6 | GHSA-mrhx-c7xc-m3w5 (high, memory exhaustion on oversized constrained collections)                                                |
| 2026-11-15 | `re2js`                                                                        | ^2.8.6 → ^2.8.7 | GHSA-gg6h-894w-4m9c (high, quadratic lookbehind matching)                                                                         |
| 2026-11-15 | `vite` (root devDependency; also `better-auth > vitest > vite`)                | ^8.3.1 → ^8.3.3 | GHSA-587h-7wmj-h5pm (high, `launch-editor` on Windows) and the two moderate `launch-editor` advisories                            |

The `@better-auth/api-key` storage notes below were re-checked against 1.7.7:
the cited lines are unchanged. The three things `044` relies on were re-checked
against 1.7.7 too: the two-factor plugin still exports only
`TWO_FACTOR_ERROR_CODES`, `twoFactor` and `twoFactorClient` (so the reset's
factor verifier keeps its own decryption, `044` Q33) and the drift test against
the installed `/two-factor/verify-totp` passes; Better Auth's three reset
routes are still off the allowlist (`auth-route-allowlist.test.ts`); and
1.7.7 still resolves `@better-auth/utils` 0.4.2 (`044` Q18).

## Audited waiver path for `pnpm audit`

An advisory that cannot be fixed within its SLA (no upstream fix, or a fix
that would need a breaking change out of scope for the current work) can be
waived, but only through this path:

1. Add the advisory identifier to `pnpm.auditConfig.ignoreCves` (a CVE) or
   `pnpm.auditConfig.ignoreGhsas` (a GHSA ID) in the root `package.json`.
2. Add a row to the waivers table below in the same pull request, with a
   justification, an owner and an expiry date. A waiver without an expiry is
   not accepted; when it expires, the advisory is re-evaluated.
3. The change goes through a normal pull request review. A waiver is never
   pushed directly to `master`, and it is never added only to silence a red
   CI run.

### Waivers table

| Advisory                                                                  | Package                                                      | Justification                                                                                                                                                                                                                                                                                                                                        | Owner     | Expiry                                                                                                        | PR                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- | -------------------- |
| GHSA-fc5q-39xc-vjpf (high, ReDoS through single-branch repeated extglobs) | `picomatch` <=4.0.7, path `better-auth > vitest > picomatch` | No patched release exists (4.0.7 is the latest). The only path is `vitest`, an optional peer of Better Auth that is test tooling and is not loaded at runtime, and no glob pattern is built from user input anywhere in the product. An override cannot help until a fixed version is published. Recorded as Resolved decision Q180 of change `045`. | `@nahuex` | 2027-02-18, or as soon as a patched `picomatch` is published: remove the waiver and add an override or update | `045` (Checkpoint 2) |

## SBOM

Every CI run produces an SPDX 2.3 JSON SBOM of the pnpm dependency tree
(`scripts/ci/syft.sh`, `sbom` job) and uploads it as the `sbom-spdx` workflow
artifact. `pnpm ci:local` produces the same file locally, written outside the
repository (under the pinned-tool cache directory) so a local run never
leaves an untracked file in the working tree.

## TLS and HSTS posture on the public ACA ingress (task 11.12, SEC05)

The application half is automated: `apps/api/src/headers.int.test.ts` asserts
that every response carries `Strict-Transport-Security` with a `max-age` of at
least one year (31536000) and `includeSubDomains`.

The ingress half is a manual, one-time check against the deployed Azure
Container Apps ingress. **Status: pending until the first deployment** (owned by `010`; `002` was archived on 2026-10-15 with task 11.12 deferred to it)
(nothing is deployed yet). Run these checks then, and record the outcome in
the table below:

1. Run an SSL Labs (or equivalent, for example `testssl.sh`) scan against the
   public hostname. Record the grade and any weak cipher finding.
2. Confirm TLS 1.0 is refused, for example
   `openssl s_client -connect <host>:443 -tls1` must fail the handshake.
3. Confirm TLS 1.1 is refused, for example
   `openssl s_client -connect <host>:443 -tls1_1` must fail the handshake.
4. Confirm TLS 1.2 and 1.3 are accepted.
5. Confirm `curl -sI https://<host>/` returns `strict-transport-security`
   with `max-age` of at least 31536000 and `includeSubDomains` (the header
   must survive the ingress, not only the application).
6. Open a ticket for every finding the scan reports.

| Check date                     | Host | Grade | TLS 1.0/1.1 disabled | HSTS at ingress | Reviewer |
| ------------------------------ | ---- | ----- | -------------------- | --------------- | -------- |
| _(pending — first deployment)_ |      |       |                      |                 |          |

Since `044` (Q25, Gate 9) this check is also a gate for turning on
`MOUNT_IDENTITY_ROUTES`, because the password-reset routes are public. Record in
the same place the state of the DNS provider's DDoS protection for the origin of
`PASSWORD_RESET_LINK_BASE_URL` and for the sender domain.

| Check date                     | Origin and sender domain | DDoS protection state | Reviewer |
| ------------------------------ | ------------------------ | --------------------- | -------- |
| _(pending — first deployment)_ |                          |                       |          |

## API key storage at rest (`@better-auth/api-key`)

Checked against the installed source of `@better-auth/api-key@1.7.7`
(`node_modules/.pnpm/@better-auth+api-key@1.7.7_*/node_modules/@better-auth/api-key/dist/index.mjs`),
not the documentation site.

- **Algorithm**: unsalted, unpeppered SHA-256 of the UTF-8 key, encoded as
  base64url without padding. `defaultKeyHasher` (L2310-L2313) calls
  `createHash("SHA-256")` from `@better-auth/utils/hash`.
- **Where it applies**: the hash is stored in the `key` column at creation
  (L806) and recomputed to look the key up on verification (L1623). The
  plaintext key is returned once and never stored.
- **Not configurable**: the only option is `disableKeyHashing` (L2331), which
  stores the plaintext key. It must never be enabled. There is no salt, pepper
  or custom hasher option.
- **Key material**: `defaultKeyGenerator` (L2358-L2361) draws
  `defaultKeyLength` (64) characters from `a-z` and `A-Z` with
  `generateRandomString` from `better-auth/crypto`, about 365 bits of entropy,
  plus an optional prefix.
- **Also stored in plaintext**: the first 6 characters of the key (`start`,
  L2345-L2348, on by default). Set `startingCharactersConfig.shouldStore` to
  `false` unless the UI needs it.

**SEC05 verdict**: meets it for high-entropy random secrets. A fast unsalted
hash is acceptable there because the key is not a human-chosen password, so
dictionary and brute-force attacks are infeasible and rainbow tables cannot
cover a 365-bit space. A slow password hash (Argon2id, bcrypt) is required
only for low-entropy secrets such as user passwords. Conditions:
`disableKeyHashing` stays `false`, `customKeyGenerator` is not used to shorten
the key, and `defaultKeyLength` is not lowered. Re-verify on every upgrade of
this package.

## Email delivery SDK (`@azure/communication-email`)

Adopted by `043-identity-lifecycle-and-org-admin` (task 1.3, design D5) for
invitation and notice email through Azure Communication Services. It is pinned
exactly to `1.1.0` (published 2025-10-08) in `packages/auth/package.json`.
Reviewed on 2026-10-09:

- **License**: MIT, on the allowlist. The 16 transitive packages it adds to the
  lockfile are MIT too (checked in each installed `package.json`; the SBOM
  records them as `NOASSERTION` because Syft reads the lockfile):

  | Package                       | Version | License |
  | ----------------------------- | ------- | ------- |
  | `@azure-rest/core-client`     | 2.9.0   | MIT     |
  | `@azure/abort-controller`     | 2.2.0   | MIT     |
  | `@azure/communication-common` | 2.5.0   | MIT     |
  | `@azure/core-auth`            | 1.11.0  | MIT     |
  | `@azure/core-client`          | 1.11.1  | MIT     |
  | `@azure/core-lro`             | 2.7.2   | MIT     |
  | `@azure/core-rest-pipeline`   | 1.25.0  | MIT     |
  | `@azure/core-tracing`         | 1.4.0   | MIT     |
  | `@azure/core-util`            | 1.14.0  | MIT     |
  | `@azure/logger`               | 1.4.0   | MIT     |
  | `@typespec/ts-http-runtime`   | 0.3.9   | MIT     |
  | `agent-base`                  | 7.1.4   | MIT     |
  | `events`                      | 3.3.0   | MIT     |
  | `http-proxy-agent`            | 7.0.2   | MIT     |
  | `https-proxy-agent`           | 7.0.6   | MIT     |
  | `jwt-decode`                  | 4.0.0   | MIT     |

- **Install scripts (`allowBuilds`)**: none of the 17 packages declares a
  `preinstall`, `install` or `postinstall` script. `jwt-decode` declares only
  `prepare` (`husky install`), which pnpm never runs for a registry tarball.
  `allowBuilds` in `pnpm-workspace.yaml` is unchanged.
- **SBOM review**: the SPDX SBOM of `scripts/ci/syft.sh` lists all 17
  packages at the versions above.
- **Advisories**: `pnpm audit --prod --audit-level=high` reports no known
  vulnerabilities.
- **Runtime notes**: the SDK sends to the endpoint named in
  `ACS_CONNECTION_STRING`, a Key Vault secret ([Secrets](secrets.md)) for a
  dedicated send-only resource (design Q28). `@azure/core-rest-pipeline`
  honors the standard `HTTPS_PROXY` and `NO_PROXY` variables, which is where
  `http-proxy-agent` and `https-proxy-agent` come from. No deployed
  environment sets them.

## TOTP check of the reset confirmation (`@better-auth/utils`)

Adopted by `044-password-reset-and-account-recovery` (task 1.2, design D6,
resolved decision Q18) as a direct dependency of `@tayzu/auth`, pinned exactly
to `0.4.2`. Reason: "TOTP check of the reset confirmation (044 D6)". The
confirm route verifies a TOTP code with `createOTP` from
`@better-auth/utils/otp`, the same call the installed Better Auth two-factor
plugin makes, instead of a hand-written RFC 6238 implementation.

- **Already locked**: `0.4.2` is the version Better Auth 1.7.6 (and 1.7.7) and its
  adapters already resolve. Making it direct adds one importer entry to
  `pnpm-lock.yaml` and no new package.
- **License**: MIT, on the allowlist.
- **Install scripts (`allowBuilds`)**: none; `allowBuilds` in
  `pnpm-workspace.yaml` is unchanged.
- **Advisories**: `pnpm audit --prod --audit-level=high` reports none.
- **Upgrades**: a drift test (044 design D6) compares this verifier with the
  installed Better Auth endpoint, so a Better Auth upgrade cannot silently
  change one side. Keep this pin in step with the version Better Auth locks.

## Web app dependencies (`003-catalog-ui-core`)

Adopted by `003-catalog-ui-core` (tasks 2.1, 2.3 and 2.4, design D3) for
`@tayzu/web` and the root lint configuration, and reviewed in task 2.2 on
2026-11-19. Every version is pinned exactly, each the latest release published
at least 14 days earlier (`003` Q43). Libraries that ship in the bundle are
`dependencies` of `@tayzu/web`, so `pnpm audit --prod` covers them; build, lint
and test tools are `devDependencies`. The root `vite` was re-pinned exactly to
8.3.5 by task 2.1, because `^8.3.3` had resolved to 8.3.8, under 14 days old
(`003` Q45).

### Direct packages

Rows marked _planned_ are not installed yet. They carry the version design D3
pins and are re-checked (license, install scripts, lockfile diff, SBOM and
audit) by the task that installs them, which then drops the mark.

| Package                                                                 | Version  | License    | Kind           | Added by |
| ----------------------------------------------------------------------- | -------- | ---------- | -------------- | -------- |
| `react`, `react-dom`                                                    | 19.3.1   | MIT        | runtime        | 2.1      |
| `@tanstack/react-query`                                                 | 5.106.0  | MIT        | runtime        | 2.1      |
| `@tanstack/react-router`                                                | 1.170.46 | MIT        | runtime        | 2.1      |
| `zustand`                                                               | 5.0.16   | MIT        | runtime        | 2.1      |
| `react-hook-form`                                                       | 7.91.0   | MIT        | runtime        | 2.1      |
| `@hookform/resolvers`                                                   | 7.0.2    | MIT        | runtime        | 2.1      |
| `zod`                                                                   | 4.6.7    | MIT        | runtime        | 2.1      |
| `i18next`                                                               | 26.7.1   | MIT        | runtime        | 2.1      |
| `react-i18next`                                                         | 17.1.12  | MIT        | runtime        | 2.1      |
| `@orpc/client`, `@orpc/openapi-client`                                  | 1.15.4   | MIT        | runtime        | 2.1      |
| `@radix-ui/react-dialog`, `-popover`                                    | 1.3.1    | MIT        | runtime        | 2.1      |
| `@radix-ui/react-dropdown-menu`                                         | 2.2.1    | MIT        | runtime        | 2.1      |
| `@radix-ui/react-tabs`                                                  | 1.2.1    | MIT        | runtime        | 2.1      |
| `@radix-ui/react-select`                                                | 2.4.1    | MIT        | runtime        | 2.1      |
| `@radix-ui/react-label`                                                 | 2.1.17   | MIT        | runtime        | 2.1      |
| `@radix-ui/react-slot`                                                  | 1.5.0    | MIT        | runtime        | 2.1      |
| `@radix-ui/react-tooltip`                                               | 1.4.1    | MIT        | runtime        | 2.1      |
| `@radix-ui/react-separator`                                             | 1.2.0    | MIT        | runtime        | 2.1      |
| `class-variance-authority`                                              | 0.7.1    | Apache-2.0 | runtime        | 2.1      |
| `clsx`                                                                  | 2.1.1    | MIT        | runtime        | 2.1      |
| `tailwind-merge`                                                        | 3.7.0    | MIT        | runtime        | 2.1      |
| `lucide-react`                                                          | 1.68.0   | ISC        | runtime        | 2.1      |
| `cmdk`                                                                  | 1.1.1    | MIT        | runtime        | 2.1      |
| `react-markdown`                                                        | 10.1.0   | MIT        | runtime        | 2.1      |
| `qrcode.react`                                                          | 4.2.0    | ISC        | runtime        | 2.1      |
| `get-nonce`                                                             | 1.0.1    | MIT        | runtime        | 2.1      |
| `tailwindcss`, `@tailwindcss/vite`                                      | 4.3.4    | MIT        | build          | 2.1      |
| `tw-animate-css`                                                        | 1.4.0    | MIT        | build          | 2.1      |
| `@vitejs/plugin-react`                                                  | 6.2.1    | MIT        | build          | 2.1      |
| `@types/react`, `@types/react-dom`                                      | 19.3.0   | MIT        | build          | 2.1      |
| `eslint-plugin-react-hooks` (root)                                      | 7.1.1    | MIT        | lint           | 2.3      |
| `eslint-plugin-jsx-a11y` (root)                                         | 6.10.2   | MIT        | lint           | 2.3      |
| `@testing-library/react`                                                | 16.3.3   | MIT        | test           | 2.4      |
| `@testing-library/dom`                                                  | 10.4.2   | MIT        | test           | 2.4      |
| `@testing-library/user-event`                                           | 14.6.8   | MIT        | test           | 2.4      |
| `@testing-library/jest-dom`                                             | 7.0.1    | MIT        | test           | 2.4      |
| `jsdom`                                                                 | 30.1.3   | MIT        | test           | 2.4      |
| `@fastify/static` (in `@tayzu/api`)                                     | 10.1.10  | MIT        | server runtime | 4.2      |
| `@playwright/test` (with `playwright` and `playwright-core`), _planned_ | 1.63.0   | Apache-2.0 | test           | 10.1     |
| `@axe-core/playwright`, _planned_                                       | 4.14.0   | MPL-2.0    | test           | 10.1     |

The planned rows were read from the npm registry metadata: none declares a
`preinstall`, `install` or `postinstall` script. `@axe-core/playwright` 4.14.0
depends on `axe-core` `~4.14.0`, which the `axe-core` 4.14.1 already locked
for `eslint-plugin-jsx-a11y` satisfies, and declares `playwright-core

> =1.0.0`as a peer, which is why`pnpm why playwright-core`must show 1.63.0
only.`@fastify/static`10.1.10 depends on`glob` `^14`, whose license is
> BlueOak-1.0.0 (see the next table); task 4.2 records it.

`@fastify/static` 10.1.10 was published on 2026-11-04, 16 days before task 4.2
(Q43; 10.1.11 and 10.1.12 are under 14 days old). It declares no peer dependency;
its `fastify-plugin` guard requires `fastify` `5.x`, which the locked 5.12.5
satisfies. Its lockfile diff adds 17 package versions, all MIT or ISC apart
from the BlueOak-1.0.0 `glob` family in the next table: `@fastify/send` 4.2.1,
`@fastify/accept-negotiator` 2.1.2, `content-disposition` 3.1.0, `mime` 3.0.0,
`http-errors` 2.0.1 (with `depd`, `inherits`, `setprototypeof`, `statuses` and
`toidentifier`), `escape-html` 1.0.3, and `glob` 14.0.6 with `minimatch` 11.0.9,
`@isaacs/nonrecursive-glob-match` 1.1.0, `path-scurry` 3.0.0 and `minipass`
7.1.3. `path-scurry` reuses the locked `lru-cache` 11.5.3. None declares a
`preinstall`, `install` or `postinstall` script.

### Notable transitive packages

The lockfile diff of tasks 2.1, 2.3 and 2.4 adds 356 package versions, every
one a package above or a transitive dependency of one (checked by walking the
lockfile graph from the direct packages). The other changed entries are 12
existing packages re-keyed by new peers and the root `vite` moving from 8.3.8
to 8.3.5. Every license not named below is on the allowlist. The notable
families:

- **unified and remark**, under `react-markdown`: `unified` 11.0.5,
  `remark-parse` 11.0.0, `remark-rehype` 11.1.2, the `mdast-util-*`,
  `hast-util-*` and `unist-util-*` packages, `vfile` 6.0.3 and
  `hast-util-to-jsx-runtime` 2.3.7, all MIT apart from
  `@ungap/structured-clone` (ISC). The `micromark` parser was
  already locked through `markdownlint`. No `rehype-raw` is installed, so raw
  HTML is never parsed (design D13).
- **Radix internals and floating-ui**, under the Radix primitives and `cmdk`:
  `@radix-ui/react-primitive`, `-presence`, `-portal`, `-dismissable-layer`,
  `-focus-scope`, `-popper`, `-menu`, `-roving-focus`, `-collection` and their
  hooks; `@floating-ui/core`, `@floating-ui/dom`, `@floating-ui/react-dom` and
  `@floating-ui/utils` (positioning); and the scroll lock that reads
  `get-nonce` (`react-remove-scroll`, `react-remove-scroll-bar`,
  `react-style-singleton`, `use-sidecar`, `use-callback-ref`, `aria-hidden`).
  All MIT.
- **Tailwind oxide and lightningcss**, under `@tailwindcss/vite`:
  `@tailwindcss/node` and `@tailwindcss/oxide` 4.3.4 (MIT), the Rust engine,
  with one prebuilt `@tailwindcss/oxide-<platform>` optional package per
  platform (MIT; pnpm installs the host's and the `wasm32-wasi` fallback), and
  `lightningcss` 1.33.0 with its `lightningcss-<platform>` binaries
  (MPL-2.0, see below), which Vite 8 already locked.
- **`axe-core`** 4.14.1 (MPL-2.0), pulled in by `eslint-plugin-jsx-a11y`, with
  its lint helpers (`aria-query`, `axobject-query`, `jsx-ast-utils`,
  `language-tags` and the `es-abstract` shim family), all on the allowlist
  apart from `axe-core`.
- **Babel**, under `eslint-plugin-react-hooks` 7 (`@babel/core` 7.29.13 and
  its helpers, MIT, with `browserslist` and `caniuse-lite`), which parses
  components for the React Compiler rules at lint time only.
- **jsdom's CSS and WHATWG packages** (`@asamuzakjp/*`, `@csstools/*`,
  `css-tree`, `parse5`, `whatwg-url`, `tough-cookie`, `undici`), test only,
  with the MIT-0 and BlueOak-1.0.0 exceptions below.

### Licenses outside the allowlist

`pnpm licenses list --json` over the installed tree finds these licenses
outside the allowlist among the packages the review covers:

| Package                                                                           | Version                             | License       | Path                                                                           | Ships?                                                                                               | Status                                                        |
| --------------------------------------------------------------------------------- | ----------------------------------- | ------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `axe-core`                                                                        | 4.14.1                              | MPL-2.0       | `eslint-plugin-jsx-a11y`                                                       | No, lint only                                                                                        | Accepted, test-only and lint-only MPL-2.0 (`003` Q26 and Q40) |
| `@axe-core/playwright` (and its `axe-core`), _planned_                            | 4.14.0                              | MPL-2.0       | direct, task 10.1                                                              | No, e2e only                                                                                         | Accepted, test-only MPL-2.0 (`003` Q26)                       |
| `lightningcss`, `lightningcss-<platform>`                                         | 1.33.0                              | MPL-2.0       | `vite`, `@tailwindcss/node`                                                    | No, it compiles CSS at build time; locked since Vite 8, before `003`                                 | Accepted, `003` Q50                                           |
| `isbot`                                                                           | 5.2.3                               | Unlicense     | `@tanstack/react-router` (a production dependency)                             | No: only the router's server-rendering entry imports it, and the client build never loads that entry | Accepted, `003` Q50                                           |
| `caniuse-lite`                                                                    | 1.0.30001826                        | CC-BY-4.0     | `browserslist`, under Babel in `eslint-plugin-react-hooks`                     | No, lint only (browser data)                                                                         | Accepted, `003` Q50                                           |
| `graceful-fs`                                                                     | 4.2.12                              | BlueOak-1.0.0 | `enhanced-resolve`, under `@tailwindcss/node`                                  | No, build only                                                                                       | Accepted, `003` Q50                                           |
| `lru-cache`                                                                       | 11.5.3                              | BlueOak-1.0.0 | `@asamuzakjp/css-color`, under `jsdom`; `path-scurry`, under `@fastify/static` | Yes, in the API image (task 4.2)                                                                     | Accepted, `003` Q50                                           |
| `glob`, `minimatch`, `path-scurry`, `minipass`, `@isaacs/nonrecursive-glob-match` | 14.0.6, 11.0.9, 3.0.0, 7.1.3, 1.1.0 | BlueOak-1.0.0 | `@fastify/static` (a production dependency of `@tayzu/api`)                    | Yes, in the API image: `glob` lists the asset files once at startup                                  | Accepted, `003` Q50                                           |
| `@csstools/color-helpers`, `@csstools/css-syntax-patches-for-csstree`             | 6.1.3, 1.1.17                       | MIT-0         | `@asamuzakjp/css-color`, under `jsdom`                                         | No, test only                                                                                        | Accepted, `003` Q50                                           |

MIT-0, BlueOak-1.0.0 and the Unlicense are OSI-approved permissive licenses;
CC-BY-4.0 is a data license that asks for attribution. None is in the "flag
for review" list. The lockfile already held BlueOak-1.0.0 (`minimatch` 10.2.6,
under ESLint) and PSF-2.0 (`argparse` 3.0.2, under `markdownlint-cli2`) before
`003`.

### Install scripts and `allowBuilds`

No `allowBuilds` entry was needed, and `pnpm-workspace.yaml` is unchanged:
`pnpm install` reports no ignored build script.

- None of the added packages declares a `preinstall`, `install` or
  `postinstall` script.
- `@hookform/resolvers`, `aria-hidden`, `enhanced-resolve`, `i18next`,
  `inline-style-parser`, `isbot`, `jsdom`, `lru-cache`, `react-hook-form`,
  `react-i18next`, `style-to-object`, `undici`, `whatwg-url` and
  `zod-validation-error` declare only `prepare`, which pnpm never runs for a
  registry tarball.
- `@tailwindcss/oxide` and `lightningcss` ship their native code prebuilt, as
  per-platform optional packages selected by `os` and `cpu`, so nothing is
  compiled or downloaded at install time.

### shadcn/ui CLI output (`003` Q44)

shadcn/ui is not a dependency (ADR-0007). Task 2.1 ran the CLI as
`npx shadcn@4.23.0`, never installed, against the default public registry
(`https://ui.shadcn.com/r`, style `radix-nova`, base color `neutral`, Lucide
icons); `components.json` names no other registry (`"registries": {}`). It
copied `alert`, `button`, `command`, `dialog`, `dropdown-menu`, `input`,
`label`, `table`, `tabs` and `tooltip`, plus `input-group` and `textarea` as
registry dependencies of `command`.

The output was adapted as `003` Q44 decided, and `apps/web/CLAUDE.md` makes
the same adaptation the rule for every later `shadcn add`:

- The CLI's additions that design D3 does not name were removed: the
  `@fontsource-variable/geist` web font, the monolithic `radix-ui` package,
  the `cn` package and the `shadcn` package (for `shadcn/tailwind.css`). None
  of them is in the lockfile.
- The copied source imports the individual `@radix-ui/react-*` packages (the
  same API; `radix-ui` 1.8.1 depends on exactly D3's primitive versions), `cn`
  from `@/lib/utils` on `clsx` and `tailwind-merge`, and the system font
  stack. The custom variants and the `no-scrollbar` utility of
  `shadcn/tailwind.css` are copied into `src/index.css` with its MIT notice.
- Every remaining dependency is pinned to D3's exact version, and the lockfile
  diff adds only D3 packages and their transitive dependencies (above).

### Single copies

- `pnpm why get-nonce`: one version, 1.0.1, shared by the Radix scroll lock
  of `dialog`, `dropdown-menu`, `popover` and `select`.
- `pnpm why playwright-core`: not installed yet. Task 10.1 installs
  `@playwright/test` 1.63.0 and `@axe-core/playwright`, and then checks that
  1.63.0 is the only copy. Dependabot never bumps either (above).

### SBOM and advisories

- **SBOM**: the SPDX SBOM of `scripts/ci/syft.sh` lists every direct package
  above at its pinned version and all 356 added package versions.
- **`pnpm audit --prod --audit-level=high`**: nothing at high or above, apart
  from the existing `picomatch` waiver (GHSA-fc5q-39xc-vjpf). No advisory of
  any severity names a package that `003` added.
- **`pnpm audit --audit-level=critical`**: no critical advisory. Two high
  advisories in `markdown-it` 15.0.1, under `markdownlint-cli2` (a root dev
  dependency that predates `003`), are reported and tracked under the fix SLA.

## Bundled data: common-password denylist

The password policy (`043` task 8.1, design Resolved decisions Q22 and Q132)
refuses passwords on a bundled common-password denylist, with no external
call and no new dependency. The list is data, not a dependency, so its
provenance is recorded here.

- **File**: `packages/auth/src/identity/common-passwords.ts`, 502 entries.
  It is generated once, never edited by hand, and changed only by a reviewed
  pull request that updates its header and this section.
- **Source**: SecLists,
  `Passwords/Common-Credentials/Pwdb_top-1000000.txt` at commit
  `27c08068f849227f2fc1c8f7f00afae365957b96` (file SHA-256
  `e9a88f67aafe65496682dc374559ee714e978bee50314767494c3e37a18c9fc8`).
- **License**: MIT (Copyright (c) 2018 Daniel Miessler). The copyright and
  permission notice are reproduced in the file header, as the license
  requires.
- **Derivation**:
  1. Decode hashcat `$HEX[...]` entries as UTF-8.
  2. NFC-normalize every entry.
  3. Keep only entries of 20 to 128 code points made solely of printable ASCII
     (U+0020-U+007E). Shorter entries are already refused by the length rule;
     the few non-ASCII entries are mis-encoded text.
  4. Lower-case, de-duplicate and sort.
- **Matching**: exact, against the candidate after NFC normalization and
  lower-casing. The breached-password check (Q23) remains the main control;
  this list is the offline layer.
