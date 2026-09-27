#!/bin/bash
# SessionStart hook for Claude Code on the web (task 1.6, openspec/changes/001-catalog-core).
# Only runs its heavy setup in the remote/cloud environment; idempotent and fast otherwise.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

# --- Node / pnpm version guard ---------------------------------------------

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "")"
if [ "$node_major" != "22" ]; then
  echo "session-start: expected Node major version 22, found '${node_major:-unknown}' ($(node --version 2>&1 || echo "node not found"))." >&2
  exit 1
fi

expected_pnpm="$(node -p "require('$PROJECT_DIR/package.json').packageManager.replace(/^pnpm@/, '')" 2>/dev/null || echo "")"
actual_pnpm="$(pnpm --version 2>/dev/null || echo "")"
if [ -z "$expected_pnpm" ] || [ -z "$actual_pnpm" ] || [ "$actual_pnpm" != "$expected_pnpm" ]; then
  echo "session-start: expected pnpm ${expected_pnpm:-<unreadable>} (from package.json's packageManager), found '${actual_pnpm:-not found}'." >&2
  exit 1
fi

# --- Start the local PostgreSQL 16 cluster if it is down -------------------

wait_for_postgres() {
  local tries=30
  while [ "$tries" -gt 0 ]; do
    if pg_isready -q; then
      return 0
    fi
    tries=$((tries - 1))
    sleep 1
  done
  return 1
}

if ! pg_isready -q; then
  pg_ctlcluster 16 main start 2>/dev/null || true
  if ! wait_for_postgres; then
    # A container restart can leave a stale postmaster.pid behind; clear it and retry once.
    pid_file="/var/lib/postgresql/16/main/postmaster.pid"
    if [ -f "$pid_file" ]; then
      rm -f "$pid_file"
    fi
    pg_ctlcluster 16 main start
    if ! wait_for_postgres; then
      echo "session-start: PostgreSQL 16 cluster failed to start." >&2
      exit 1
    fi
  fi
fi

# --- Create the test-only login role and database, idempotently ------------
# Fixed literals only, no interpolation of untrusted input.

su postgres -c "psql -v ON_ERROR_STOP=1 -q" <<'SQL'
DO $do$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'tayzu') THEN
      CREATE ROLE tayzu LOGIN PASSWORD 'tayzu';
   END IF;
END
$do$;

SELECT 'CREATE DATABASE tayzu_test OWNER tayzu'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'tayzu_test')\gexec
SQL

# --- Export DATABASE_URL for the session, test credentials only ------------

database_url_line='export DATABASE_URL=postgres://tayzu:tayzu@localhost:5432/tayzu_test'
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  if [ ! -f "$CLAUDE_ENV_FILE" ] || ! grep -qF "$database_url_line" "$CLAUDE_ENV_FILE"; then
    echo "$database_url_line" >> "$CLAUDE_ENV_FILE"
  fi
fi

# --- Install workspace dependencies if missing ------------------------------

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  (cd "$PROJECT_DIR" && pnpm install --frozen-lockfile)
fi

exit 0
