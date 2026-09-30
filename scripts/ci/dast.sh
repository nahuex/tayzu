#!/usr/bin/env bash
# DAST stack for the OWASP ZAP baseline scan (task 15.1, design D16), shared
# by the `dast-zap` CI job and `pnpm ci:local`.
#
#   dast.sh up     PostgreSQL 16 behind verified TLS, migrations, apps/api
#                  (main.ts) and one seeded organization and session
#   dast.sh scan   the ZAP baseline scan, with the same image and command
#                  the pinned zaproxy/action-baseline runs in CI
#   dast.sh down   stops the API and the database
#   dast.sh all    up, scan and down (the local equivalent of the CI job)
#
# The database keeps design D5's rule: every connection uses
# `sslmode=verify-full`. Each run generates a throwaway CA and a `localhost`
# server certificate, so nothing here relaxes TLS. The database password and
# BETTER_AUTH_SECRET are random per run and never printed; the session
# cookie reaches ZAP only through ZAP_AUTH_HEADER_VALUE (masked in CI).
#
# Cerbos must already be running (CI starts the pinned image; locally,
# scripts/dev/start-cerbos.sh or the SessionStart hook does).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Same image the CI Postgres service used before this job needed TLS.
PG_IMAGE="${DAST_PG_IMAGE:-postgres:16}"
# ghcr.io/zaproxy/zaproxy:stable, pinned by digest like the Cerbos image.
ZAP_IMAGE="${DAST_ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef}"
PG_CONTAINER="tayzu-dast-postgres"
PG_PORT="${DAST_PG_PORT:-5433}"
API_PORT="${DAST_API_PORT:-3000}"
CERBOS_ADDRESS="${CERBOS_ADDRESS:-localhost:3593}"
CERBOS_HEALTH_URL="${DAST_CERBOS_HEALTH_URL:-http://localhost:3592/_cerbos/health}"
STATE_DIR="${DAST_STATE_DIR:-${RUNNER_TEMP:-/tmp}/tayzu-dast}"

log() {
  echo "dast: $*"
}

fail() {
  echo "dast: $*" >&2
  exit 1
}

# Hides a generated value from GitHub Actions logs. A no-op elsewhere.
mask() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::add-mask::$1"
  fi
}

# Retries a command once per second; returns 1 when it never succeeds.
wait_for() {
  local attempts="$1"
  shift
  for _ in $(seq 1 "$attempts"); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# A CA and a server certificate for `localhost` and 127.0.0.1, valid one day.
generate_tls() {
  local dir="$STATE_DIR/tls"
  mkdir -p "$dir"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=tayzu-dast-ca" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$dir/ca.key" -out "$dir/ca.crt" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
    -keyout "$dir/server.key" -out "$dir/server.csr" 2>/dev/null
  printf '%s\n' \
    "basicConstraints=CA:FALSE" \
    "keyUsage=critical,digitalSignature,keyEncipherment" \
    "extendedKeyUsage=serverAuth" \
    "subjectAltName=DNS:localhost,IP:127.0.0.1" >"$dir/server.ext"
  openssl x509 -req -in "$dir/server.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" \
    -CAcreateserial -days 1 -extfile "$dir/server.ext" -out "$dir/server.crt" 2>/dev/null
  rm -f "$dir/ca.key" "$dir/server.csr" "$dir/server.ext" "$dir/ca.srl"
}

# PostgreSQL 16 with ssl=on. The key is copied inside the container so it is
# owned by the postgres user with mode 0600, which the server requires.
start_postgres() {
  local password="$1"
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER=tayzu \
    -e POSTGRES_PASSWORD="$password" \
    -e POSTGRES_DB=tayzu_dast \
    -p "127.0.0.1:$PG_PORT:5432" \
    -v "$STATE_DIR/tls:/tls-source:ro" \
    --entrypoint bash \
    "$PG_IMAGE" \
    -c 'install -d -o postgres -g postgres -m 0700 /tls &&
        install -o postgres -g postgres -m 0600 /tls-source/server.crt /tls-source/server.key /tls/ &&
        exec docker-entrypoint.sh postgres -c ssl=on \
          -c ssl_cert_file=/tls/server.crt -c ssl_key_file=/tls/server.key' \
    >/dev/null
}

postgres_accepts_tls() {
  # `pg_isready` inside the container only proves the socket is up; this
  # proves a verified TLS handshake from the host, as the API will make it.
  (cd "$REPO_ROOT/packages/db" && node --input-type=module -e "
    import pg from 'pg';
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query('select 1');
    await client.end();
  ")
}

up() {
  command -v openssl >/dev/null || fail "openssl is required"
  curl -sf "$CERBOS_HEALTH_URL" >/dev/null ||
    fail "Cerbos is not healthy at $CERBOS_HEALTH_URL (start it first)"

  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"

  local password secret database_url
  password="$(openssl rand -hex 24)"
  secret="$(openssl rand -hex 32)"
  mask "$password"
  mask "$secret"

  generate_tls
  start_postgres "$password"
  database_url="postgres://tayzu:${password}@localhost:${PG_PORT}/tayzu_dast?sslmode=verify-full&sslrootcert=${STATE_DIR}/tls/ca.crt"

  export DATABASE_URL="$database_url"
  export AUTH_DATABASE_URL="$database_url"
  export BETTER_AUTH_SECRET="$secret"
  # Q40: https outside test. The scan reaches the listener over plain HTTP on
  # localhost; the configured origin only drives cookie and origin settings.
  export BETTER_AUTH_URL="https://localhost:${API_PORT}"
  export ALLOWED_ORIGINS="http://localhost:${API_PORT}"
  export CERBOS_ADDRESS
  export PORT="$API_PORT"
  export HOST="127.0.0.1"
  export ZAP_TARGET_URL="http://localhost:${API_PORT}"
  # Q41: an explicit opt-out; the throwaway stack has no OTLP collector.
  export TAYZU_TELEMETRY_DISABLED="true"

  log "waiting for PostgreSQL (verified TLS)"
  wait_for 60 postgres_accepts_tls || fail "PostgreSQL did not accept a verified TLS connection in time"

  log "applying migrations"
  (cd "$REPO_ROOT" && pnpm db:migrate)

  log "starting apps/api"
  # Its own session, so `down` can stop pnpm and the API it starts together.
  setsid nohup pnpm --dir "$REPO_ROOT" --filter @tayzu/api start \
    </dev/null >"$STATE_DIR/api.log" 2>&1 &
  echo $! >"$STATE_DIR/api.pid"
  if ! wait_for 60 curl -sf "http://localhost:${API_PORT}/healthz"; then
    tail -n 50 "$STATE_DIR/api.log" >&2 || true
    fail "apps/api did not become healthy in time"
  fi

  log "seeding an organization and a session"
  (cd "$REPO_ROOT" && ZAP_ENV_FILE="${GITHUB_ENV:-$STATE_DIR/zap.env}" pnpm exec tsx scripts/ci/zap-seed.ts)
  log "stack is up at http://localhost:${API_PORT}"
}

scan() {
  local env_file="$STATE_DIR/zap.env"
  [ -f "$env_file" ] || fail "run 'dast.sh up' first (no seeded session)"
  local work="$STATE_DIR/zap"
  mkdir -p "$work"
  touch "$work/report_json.json" "$work/report_md.md" "$work/report_html.html"
  chmod -R a+rwX "$work"

  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
  export ZAP_AUTH_HEADER_SITE="localhost"

  docker pull -q "$ZAP_IMAGE" >/dev/null
  local code=0
  docker run --rm -v "$work:/zap/wrk/:rw" --network=host \
    -e ZAP_AUTH_HEADER -e ZAP_AUTH_HEADER_VALUE -e ZAP_AUTH_HEADER_SITE \
    "$ZAP_IMAGE" zap-baseline.py -t "http://localhost:${API_PORT}" \
    -J report_json.json -w report_md.md -r report_html.html || code=$?
  # zap-baseline.py: 1 = a FAIL alert, 2 = a WARN alert, 3 = the scan failed.
  # The CI action (fail_action: true) fails the job on 1 and 2, and so does this.
  case "$code" in
    0) log "ZAP baseline scan passed (reports in $work)" ;;
    1 | 2) fail "ZAP baseline scan found alerts (exit $code, reports in $work)" ;;
    *) fail "ZAP baseline scan could not run (exit $code)" ;;
  esac
}

down() {
  if [ -f "$STATE_DIR/api.pid" ]; then
    local pid
    pid="$(cat "$STATE_DIR/api.pid")"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    rm -f "$STATE_DIR/api.pid"
  fi
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  log "stack stopped"
}

# `pnpm ci:local` counts exit 77 as an explicit SKIP (scripts/ci/local.sh).
if ! docker info >/dev/null 2>&1; then
  echo "dast: docker is not available; the DAST stack cannot run here" >&2
  exit 77
fi

case "${1:-}" in
  up) up ;;
  scan) scan ;;
  down) down ;;
  all)
    trap down EXIT
    up
    scan
    ;;
  *)
    echo "usage: dast.sh up|scan|down|all" >&2
    exit 2
    ;;
esac
