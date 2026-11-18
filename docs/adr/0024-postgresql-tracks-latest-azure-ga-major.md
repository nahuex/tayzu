# ADR-0024: PostgreSQL tracks the latest major version that Azure offers in GA

- **Status**: Accepted
- **Date**: 2026-11-17
- **Change**: none (a project-wide rule on the database version; it applies to
  every change from now on, first to the move from PostgreSQL 16 to 18)

Number `0019` is reserved for `045-org-deletion-and-data-retention`, so this is
the next free number after `0023`.

## Context

`openspec/project.md` (Section 2) fixes the database as PostgreSQL on Azure
Database for PostgreSQL Flexible Server, without a version. PostgreSQL 16 was
never a recorded decision: it came in as part of the fixed stack listed in the
designs of `001-catalog-core` and `002-auth-and-rbac`, and from there it was
pinned everywhere the project runs a database: the CI service containers
(`postgres:16` by digest), the DAST stack (`scripts/ci/Dockerfile.images`),
`compose.yaml`, the cloud sandbox's apt cluster `16 main`, and the docs.

On 2026-11-17 the latest stable PostgreSQL major is 18 (minor 18.7). Azure
Database for PostgreSQL Flexible Server offers 18 in general availability and
19 only in preview. Nothing is deployed yet (the Azure environment is `010`),
so no production database has to be upgraded.

## Decision

1. **The rule.** Tayzu runs the latest stable PostgreSQL major version that
   Azure Database for PostgreSQL Flexible Server offers in general
   availability. A major that upstream has released but Azure offers only in
   preview does not qualify. The human decided this on 2026-11-17.
2. **Today that is PostgreSQL 18.** CI (`test`, `otel-smoke-check` and the
   DAST stack) uses `postgres:18` pinned by digest, `compose.yaml` uses
   `postgres:18`, and the cloud sandbox runs the apt cluster `18 main` on
   `localhost:5432`, installed from the PostgreSQL project's apt repository
   (PGDG), because Ubuntu noble ships only 16.
3. **Minor versions** follow the pinned digests, which Dependabot's `docker`
   ecosystem bumps (`docs/security/dependencies.md`). Only a new major version
   needs a change of its own.
4. **When Azure takes a newer major to GA** (19, for example), the project
   moves to it in a dedicated change, under this rule.

## Alternatives considered

- **Stay on PostgreSQL 16.** It works and needs no change today, but every
  later upgrade gets larger, the first production deployment would start two
  majors behind, and 16 reaches the end of community support (November 2028)
  sooner than 18. Rejected.
- **Jump to PostgreSQL 19.** It reaches general availability upstream on
  2026-11-19, but Azure Flexible Server offers it only in preview, so
  development and CI would run a version production cannot run with GA
  support. Rejected until Azure makes 19 GA.

## Consequences

- CI, `compose.yaml`, the sandbox's SessionStart hook and the docs
  (`CLAUDE.md` files, `docs/dev-environment/README.md`,
  `docs/architecture/system-diagram.md`, `docs/security/dependencies.md`) move
  together, in the same change, whenever the major changes. A partial move
  would test against one version and develop against another.
- A later major upgrade is a deliberate change with a full test run
  (`pnpm test --force`) on the new major. Behaviour that the new major
  changes is diagnosed and fixed in production code or recorded, never hidden
  by loosening a test.
- A `compose.yaml` volume from the previous major is not reusable: developers
  start from a fresh volume or dump and restore. The sandbox's hook creates
  the new cluster next to any older one and leaves the older one alone.
- The sandbox now depends on `apt.postgresql.org` being reachable the first
  time it installs the server package.
- Once production exists, a major upgrade is planned in `010`'s runbook
  (Azure's major version upgrade, a backup taken first, a rehearsal on a copy
  and a rollback path) before the change that moves CI lands.
