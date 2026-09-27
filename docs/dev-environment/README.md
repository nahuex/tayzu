# Development environment: cloud sandbox and local laptop

Tayzu is built with Claude Code. Most of the work so far ran in the Claude
Code cloud sandbox (Claude Code on the web). This page lists everything that
sandbox provides behind the scenes, and how to reproduce each piece on a
laptop with Docker, so that the project never depends on the cloud offering.

## What the cloud sandbox provides

| Piece                                                              | In the cloud sandbox                                                                                | On a laptop                                                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Operating system                                                   | Ubuntu 24.04 container, recreated when idle                                                         | macOS, Linux or Windows with WSL2                                                                                          |
| Node.js                                                            | 22.x preinstalled                                                                                   | Install Node 22 (for example with `fnm` or `nvm`)                                                                          |
| pnpm                                                               | 10.33.0 preinstalled                                                                                | `corepack enable`; `packageManager` in `package.json` pins the version                                                     |
| PostgreSQL 16                                                      | Local cluster `16 main` on `localhost:5432`, started by `.claude/hooks/session-start.sh`            | `docker compose up -d --wait db` (see [`compose.yaml`](../../compose.yaml))                                                |
| Test role and database                                             | Role `tayzu` / password `tayzu` with `CREATEDB`, database `tayzu_test`, created by the hook         | Created by the `postgres:16` image from `compose.yaml` (the image's user is a superuser)                                   |
| `DATABASE_URL`                                                     | Exported by the hook through `CLAUDE_ENV_FILE`                                                      | Export it yourself (see below)                                                                                             |
| Dependencies                                                       | `pnpm install --frozen-lockfile` by the hook when `node_modules` is missing                         | `pnpm install --frozen-lockfile`                                                                                           |
| Docker                                                             | Available, rarely needed                                                                            | Docker Desktop, or Docker Engine with the Compose plugin                                                                   |
| Chromium                                                           | Preinstalled at `/opt/pw-browsers` (used to render Mermaid)                                         | Downloaded automatically by Puppeteer or Playwright                                                                        |
| Network                                                            | Outbound through a proxy (npm, GitHub, docs)                                                        | Direct                                                                                                                     |
| OpenSpec CLI                                                       | `npx -y @fission-ai/openspec@latest`                                                                | Same command                                                                                                               |
| CI tools for `pnpm ci:local` (gitleaks, Semgrep, Syft, actionlint) | Downloaded at pinned versions into a cache dir by the scripts                                       | Same scripts, same pinned versions                                                                                         |
| GitHub access                                                      | The GitHub MCP connector (PRs, CI status, comments) plus `git push` through the sandbox proxy       | `git` with your own credentials and the GitHub CLI `gh`                                                                    |
| Subagents                                                          | `.claude/agents/*.md` (`test-writer`, `implementer`, `observability-auditor`, `vcdm-ssa-validator`) | Same files, loaded by the local Claude Code CLI                                                                            |
| Skills                                                             | `.claude/skills/` (OpenSpec skills, `ssa-validator` symlinks to `.agents/skills/`)                  | Same files. On Windows, enable symlinks in Git (`core.symlinks=true`) or copy the two SSA skill files                      |
| Hooks                                                              | `SessionStart` (sandbox setup), `tdd-path-guard.sh` (TDD role split)                                | `tdd-path-guard.sh` works as is. The SessionStart hook exits immediately outside the cloud (`CLAUDE_CODE_REMOTE` is unset) |

### Cloud-only conveniences

These are features of Claude Code on the web. They have no local equivalent,
and nothing in the repository depends on them:

- **PR activity subscription**: CI failures and review comments on a PR wake
  the session automatically. Locally, check with `gh pr checks` and
  `gh pr view --comments`, or ask Claude to do it.
- **Scheduled check-ins** (`send_later`): locally, re-run the check yourself.
- **The GitHub MCP connector**: locally, Claude Code uses `gh` through Bash.
  Run `gh auth login` once.

## Working locally, step by step

1. Install Node 22, Docker, Git and the GitHub CLI. Then run
   `corepack enable`.
2. Install Claude Code: `npm install -g @anthropic-ai/claude-code`. Run
   `claude` in the repository root and log in.
3. Start PostgreSQL and install dependencies:

   ```sh
   docker compose up -d --wait db
   export DATABASE_URL=postgres://tayzu:tayzu@localhost:5432/tayzu_test
   pnpm install --frozen-lockfile
   ```

   If port 5432 is already taken, use another one:
   `TAYZU_DB_PORT=5433 docker compose up -d --wait db`, and put `5433` in
   `DATABASE_URL`.

4. Check that everything works:

   ```sh
   pnpm lint && pnpm typecheck && pnpm test
   pnpm ci:local        # the same steps as GitHub Actions
   ```

5. Stop the database with `docker compose down`. Add `-v` to also delete its
   data volume; the tests recreate what they need.

Keep `DATABASE_URL` in your shell profile, or in a `.env` file that you load
yourself. `.env*` files are git-ignored, so they are never committed.

## Keeping this page true

- When a change adds a service (for example Redis in 004 or Cerbos in 002),
  add it to [`compose.yaml`](../../compose.yaml) and to the table above, in
  the same PR.
- When the SessionStart hook starts something new in the cloud, the local
  equivalent goes here too.
- The only credentials in `compose.yaml` and in the hook are test-only
  (`tayzu`/`tayzu`), bound to loopback. Real secrets never go in either file.
