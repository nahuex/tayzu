# Tayzu: conventions for Claude Code

Tayzu is an Agentic SDLC Platform (the evolution of an IDP into an ADP). The
fixed project rules live in `openspec/project.md`: read it before any
non-trivial work. This file is the short, stable summary. Each package adds its
local rules in `packages/<name>/CLAUDE.md`.

## Language

- Every artifact is in **English**, with no exception: code, identifiers,
  comments, commit messages, OpenSpec artifacts, ADRs, docs, error messages,
  logs and telemetry names.
- The only exception is the chat with the human, which is in **Spanish**.

## Human-in-the-loop flow

- Work happens through OpenSpec changes in `openspec/changes/<change>/`
  (`proposal.md`, `specs/`, `design.md`, `tasks.md`). Implement tasks in
  order and exactly as written. Do not edit `openspec/` unless asked.
- **Checkpoint 1**: the human approves the proposal before any code exists.
- **Checkpoint 2**: the human reviews the complete PR.
- **Checkpoint 3** (always, no exceptions): every database migration and every
  Cerbos policy change is approved explicitly and separately, even when the
  rest of the PR is already approved. Stop and wait for that approval.
- Open questions that only the human can answer are **always asked in chat**,
  never only written in a file. Give 2 to 4 concrete options, mark the
  recommended one and say why. Nothing counts as approved until the human
  answers. Then record the answer in the design's "Resolved decisions".

## Agentic TDD

Every task in `tasks.md`, except the ones marked _(setup)_, is one
red-green-refactor cycle:

1. **Red**: the `test-writer` subagent writes only the test named in the task's
   Verify clause, runs it, and shows it fails for the expected reason (missing
   behavior, not a typo or a missing import).
2. **Green**: the `implementer` subagent writes the minimum production code that
   makes it pass, without touching the test.
3. **Refactor** with every test green, then run `pnpm --filter <pkg> test`,
   `pnpm lint` and `pnpm typecheck`.
4. The orchestrator ticks the box and commits with the task number, for
   example `feat(catalog): 4.3 relation value validation`.

- The two roles run in separate contexts on purpose, so that tests encode the
  spec, not the implementation. `.claude/hooks/tdd-path-guard.sh` enforces the
  split: the test-writer only writes tests, the implementer never does.
- Never `.skip`, `.only` or `.todo` a test, and never loosen an assertion. If a
  test contradicts the spec, stop and report it.
- After the implementer, `observability-auditor` checks that the declared
  telemetry really exists.
- Subagents never commit, push or create branches. The orchestrator commits.

## Security invariants

- **Tenant isolation**: every query filters by `tenant_id`, operations fail
  closed without a valid context, and cross-tenant access looks exactly like
  "not found".
- **Host-supplied context**: `tenantId` and `actor` come only from the trusted
  host, never from procedure input, path, query or body.
- **Same path for humans and agents**: there is one operation pipeline.
  `actor.type` is data and never selects a code path, except in
  `packages/catalog/src/domain/reserved.ts` and
  `packages/catalog/src/service/pipeline.ts` (lint-enforced; the actor-parity
  test matrix is the real guard).
- **Parameterized SQL only**: `sql.raw` is banned by lint. The tenant is set
  with `set_config('app.tenant_id', $1, true)`, never interpolated.
- **Untrusted input**: parse into null-prototype objects, reject `__proto__`,
  `constructor` and `prototype` at every depth, and check limits before any
  expensive work (validation, compilation, database).
- **No tenant free text in telemetry or errors**: property values, titles,
  descriptions, validation messages and SQL bind values never reach spans,
  metrics, logs or error responses. Internal errors are sanitized.
- **Secrets**: configuration comes from the environment only. `.env*` files are
  git-ignored and never committed. Never print `DATABASE_URL`.
- **TLS**: database connections require `sslmode=verify-full` outside the test
  harness.
- **Dependencies**: add one only when the design names it. Dependency install
  scripts stay blocked unless `allowBuilds` in `pnpm-workspace.yaml` allows
  them explicitly.

## No network exposure before 002

APIs are invoked in-process only (`createRouterClient(router, { context })`).
Do not add an HTTP listener, a Fastify app, a dev-only header, or any other way
to reach an API over the network until `002-auth-and-rbac` puts authentication
and Cerbos in front of it.

## Workspace

- pnpm workspaces + Turborepo. Packages: `@tayzu/observability`, `@tayzu/db`,
  `@tayzu/catalog` in `packages/`. Workspace dependencies use `workspace:*`.
- **Just-in-Time packages**: `exports` point at `./src/*.ts` and there is no
  build output. Vitest, tsx and tsc consume the TypeScript source directly, so
  `build` is a typecheck for now. Run TypeScript scripts with `tsx`.
- `tsconfig.base.json`: ES2023, ESNext modules, `moduleResolution: Bundler`,
  `verbatimModuleSyntax`, `strict`, `noUncheckedIndexedAccess`. TypeScript is
  pinned to `~6.0.3` because typescript-eslint supports `<6.1.0`. Do not
  upgrade to TypeScript 7.
- Relative imports in `src/` use the `.js` extension (`./domain/context.js`).
  Type-only imports use `import type`.
- Lint: ESLint with typescript-eslint `strictTypeChecked`, plus markdownlint
  over `docs/**/*.md` and every `CLAUDE.md`. Format with Prettier.

## Commands

```sh
pnpm install              # install (pnpm 10, Node 22)
pnpm lint                 # eslint . && markdownlint
pnpm typecheck            # root config files + every package
pnpm test                 # unit + integration tests, through Turborepo
pnpm test:unit            # unit tests only, no database needed
pnpm --filter @tayzu/catalog test   # one package
pnpm test:projects        # every package in one Vitest process (root config)
pnpm format               # prettier --write .
pnpm ci:local             # the CI steps, locally
```

`contract:generate`, `contract:check`, `otel-smoke-check` and `db:migrate`
run the package scripts of the same name. They pass trivially until a package
defines them.

## Running tests

- Unit tests are `*.test.ts` next to the code. Integration tests are
  `*.int.test.ts` and run against a real PostgreSQL 16 through `DATABASE_URL`.
- Each package has two Vitest projects, `<pkg> (unit)` and `<pkg> (int)`.
- A run that includes integration tests fails fast, with an explicit message,
  when `DATABASE_URL` is missing. Export it first, for example
  `export DATABASE_URL=postgres://<user>:<password>@localhost:5432/tayzu_test`.
  Cloud sandbox: cluster `16 main` on `localhost:5432`. Laptop: `docker compose
up -d --wait db`. Both are described in `docs/dev-environment/README.md`.
- Isolation is tenant-per-test: each test uses a fresh random `tenantId`, so
  tests run in parallel without truncating tables.
- Turborepo caches passing runs (`DATABASE_URL` is part of the `test` hash).
  Use `pnpm test --force` to bypass the cache.

## Observability and docs

- References (project.md §22): read your change's row in
  `docs/references/platform-engineering/README.md` before proposing it.

- Every `design.md` declares its telemetry contract (spans, metrics, log
  events) before implementation. Code uses only the declared names, and
  `otel-smoke-check` enforces them. Libraries depend on the OTel API only.
- Docs-as-Code: write ADRs in `docs/adr/` the same day a decision is made, and
  never archive a change without updating its docs. Update
  `docs/architecture/system-diagram.md` whenever a component, actor or network
  interaction changes.
