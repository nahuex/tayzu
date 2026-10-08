# Dependency and supply-chain security policy

This document is the policy behind `.github/dependabot.yml`,
`.github/workflows/ci.yml` and the `pnpm.auditConfig` field of the root
`package.json`. It resolves R7 and R14 of
`openspec/changes/archive/2026-09-28-001-catalog-core/design.md` (task 1.7) and covers SEC07 of
the SSA.

## Automated updates

Dependabot opens weekly pull requests for two ecosystems
(`.github/dependabot.yml`):

- **npm**, root directory. Minor and patch updates are grouped into a single
  pull request so routine bumps do not create update noise; a major update
  still opens its own pull request for review.
- **github-actions**, root directory. Every action pinned in `ci.yml` and the
  composite action under `.github/actions/setup/` is covered.

Runtime-coupled versions are held on purpose. `@types/node` stays on the
major version of the Node runtime (22), so Dependabot ignores its major
updates (`.github/dependabot.yml`); moving to a new Node major is an
explicit decision that updates the runtime, `engines` and these types
together.

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
- **Semgrep OSS** (`semgrep` job) runs the `p/typescript`, `p/nodejs` and
  `p/secrets` registry rulesets and blocks on `ERROR` severity. `--config auto`
  is never used: it requires a Semgrep login and sends telemetry that this
  project does not want in CI.
- **Syft** (`sbom` job) generates an SPDX JSON SBOM of the pnpm dependency
  tree on every run and uploads it as the `sbom-spdx` workflow artifact. This
  step is **non-blocking** (`continue-on-error: true`): a SBOM generation
  failure is visible in the job log but never fails the pipeline.

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
| re2js       | ^2.8.6          | Actively maintained; no published EOL                                                         |
| Ajv         | ^8.20.0         | Actively maintained; no published EOL                                                         |

| Review date                                                             | Reviewer | Outcome |
| ----------------------------------------------------------------------- | -------- | ------- |
| _(none yet — first review is due one quarter after this change merges)_ |          |         |

## License review before adopting a dependency

Before adding a dependency that is not already in the lockfile, check its
declared license.

**Allowlist (OSI-approved, adopt freely):** MIT, Apache-2.0, BSD-2-Clause,
BSD-3-Clause, ISC, 0BSD, Python-2.0, CC0-1.0.

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

| Advisory              | Package | Justification | Owner | Expiry | PR  |
| --------------------- | ------- | ------------- | ----- | ------ | --- |
| _(no active waivers)_ |         |               |       |        |     |

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
Container Apps ingress. **Status: pending until the first deployment**
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

## API key storage at rest (`@better-auth/api-key`)

Checked against the installed source of `@better-auth/api-key@1.7.6`
(`node_modules/.pnpm/@better-auth+api-key@1.7.6_*/node_modules/@better-auth/api-key/dist/index.mjs`),
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
