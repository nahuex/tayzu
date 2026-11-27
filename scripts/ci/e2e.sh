#!/usr/bin/env bash
# E2E stack for the Playwright suite of apps/web/e2e (003 task 10.1, design
# D16, Resolved decision Q38), shared by the `e2e` CI job and `pnpm e2e`.
#
#   e2e.sh up     PostgreSQL 18 behind verified TLS, migrations, the OIDC stub
#                 of @tayzu/auth as Visma Connect, the built apps/web served by
#                 apps/api (main.ts, production configuration), the test-only
#                 TLS reverse proxy in front of the API and the stub, then the
#                 seed (apps/web/e2e/fixtures/seed.ts)
#   e2e.sh test   the Playwright suite of @tayzu/web against that stack
#   e2e.sh down   stops the proxy, the stub, the API and the database
#   e2e.sh all    up, test and down (what `pnpm e2e` runs)
#
# Outside the test harness every origin must be https (Better Auth's trusted
# origins and the accept and reset Origin checks refuse http), so the browser
# reaches the API and the stub only through the proxy, whose `localhost`
# certificate is signed by a throwaway CA generated per run. The database
# keeps design D5's rule: every connection uses `sslmode=verify-full`.
# Nothing here relaxes TLS: Node trusts the CA through NODE_EXTRA_CA_CERTS and
# Chromium trusts it by its SPKI hash (apps/web/playwright.config.ts).
#
# Every password and secret is random per run and never printed. The seed
# writes the run's credentials and links to $STATE_DIR/seed.json (mode 0600),
# which this script never reads.
#
# Cerbos must already be running (CI starts the pinned image; locally,
# scripts/dev/start-cerbos.sh or the SessionStart hook does).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# postgres, pinned by digest in Dockerfile.images so that Dependabot can read
# and bump it (as for dast.sh).
pinned_image() {
  awk -v stage="$1" '$1 == "FROM" && $4 == stage { print $2 }' "$SCRIPT_DIR/Dockerfile.images"
}
PG_IMAGE="${E2E_PG_IMAGE:-$(pinned_image postgres)}"
PG_CONTAINER="tayzu-e2e-postgres"
PG_PORT="${E2E_PG_PORT:-5434}"
# The API and the stub listen on 127.0.0.1 over plain HTTP; only the proxy's
# https ports are origins the browser sees.
API_PORT="${E2E_API_PORT:-3001}"
OIDC_STUB_PORT="${E2E_OIDC_STUB_PORT:-3002}"
APP_PORT="${E2E_APP_PORT:-8443}"
OIDC_PORT="${E2E_OIDC_PORT:-8444}"
CERBOS_ADDRESS="${CERBOS_ADDRESS:-localhost:3593}"
CERBOS_HEALTH_URL="${E2E_CERBOS_HEALTH_URL:-http://localhost:3592/_cerbos/health}"
STATE_DIR="${E2E_STATE_DIR:-${RUNNER_TEMP:-/tmp}/tayzu-e2e}"
# Where the seed writes seed.json and the shared fixture reads it, and where
# playwright.config.ts finds the CA and puts its traces and report.
export E2E_STATE_DIR="$STATE_DIR"
# The app's https origin (the proxy), for playwright.config.ts's baseURL.
export E2E_BASE_URL="https://localhost:${APP_PORT}"

log() {
  echo "e2e: $*"
}

fail() {
  echo "e2e: $*" >&2
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

# `up` deletes the state directory: it must be absolute and outside the repository.
check_state_dir() {
  case "$STATE_DIR" in
    /*) ;;
    *) fail "E2E_STATE_DIR must be an absolute path" ;;
  esac
  case "$STATE_DIR/" in
    / | "$REPO_ROOT"/*) fail "E2E_STATE_DIR must be outside the repository" ;;
  esac
}

# Signs a `localhost` server certificate named $1 with the run's CA.
sign_localhost() {
  local dir="$STATE_DIR/tls" name="$1"
  openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
    -keyout "$dir/$name.key" -out "$dir/$name.csr" 2>/dev/null
  printf '%s\n' \
    "basicConstraints=CA:FALSE" \
    "keyUsage=critical,digitalSignature,keyEncipherment" \
    "extendedKeyUsage=serverAuth" \
    "subjectAltName=DNS:localhost,IP:127.0.0.1" >"$dir/$name.ext"
  openssl x509 -req -in "$dir/$name.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" \
    -CAcreateserial -days 1 -extfile "$dir/$name.ext" -out "$dir/$name.crt" 2>/dev/null
  rm -f "$dir/$name.csr" "$dir/$name.ext"
}

# One CA per run, valid one day, and two `localhost` certificates it signs:
# `server` for PostgreSQL and `proxy` for the TLS reverse proxy. The CA key is
# deleted once both are signed.
generate_tls() {
  local dir="$STATE_DIR/tls"
  mkdir -p "$dir"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=tayzu-e2e-ca" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$dir/ca.key" -out "$dir/ca.crt" 2>/dev/null
  sign_localhost server
  sign_localhost proxy
  rm -f "$dir/ca.key" "$dir/ca.srl"
  # The proxy presents its certificate with the CA, so Chromium finds the CA's
  # SPKI hash in the chain.
  cat "$dir/proxy.crt" "$dir/ca.crt" >"$dir/proxy-chain.crt"
  # Node keeps the CAs it already trusts (a corporate proxy's, for example)
  # and adds this run's.
  if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$NODE_EXTRA_CA_CERTS" ]; then
    cat "$NODE_EXTRA_CA_CERTS" "$dir/ca.crt" >"$dir/node-ca.crt"
  else
    cp "$dir/ca.crt" "$dir/node-ca.crt"
  fi
}

# PostgreSQL 18 with ssl=on. The key is copied inside the container so it is
# owned by the postgres user with mode 0600, which the server requires.
start_postgres() {
  local password="$1"
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER=tayzu \
    -e POSTGRES_PASSWORD="$password" \
    -e POSTGRES_DB=tayzu_e2e \
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
    const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await client.connect();
    await client.query('select 1');
    await client.end();
  ")
}

# A verified https request through the proxy, trusting only the run's CA.
https_ok() {
  curl -sf --cacert "$STATE_DIR/tls/ca.crt" "$1"
}

# Starts a long-running process in its own session, so `down` stops it and its
# children together. $1 names the pid and log files in $STATE_DIR.
start_background() {
  local name="$1"
  shift
  setsid nohup "$@" </dev/null >"$STATE_DIR/$name.out" 2>&1 &
  echo $! >"$STATE_DIR/$name.pid"
}

up() {
  command -v openssl >/dev/null || fail "openssl is required"
  check_state_dir
  curl -sf "$CERBOS_HEALTH_URL" >/dev/null ||
    fail "Cerbos is not healthy at $CERBOS_HEALTH_URL (start it first)"

  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"

  # 003 design D9: the API serves the built web app. Built before the stub
  # import below, so Vite runs with the caller's NODE_OPTIONS; a failed build
  # fails `up`.
  log "building apps/web"
  (cd "$REPO_ROOT" && pnpm --filter @tayzu/web build)

  # The breached-password plugin would call api.pwnedpasswords.com from the
  # API server and the seed's bootstrap child. Both load the shared stub of
  # 002 task 8.1a (an empty range) for the whole `up` (Q71), as dast.sh does.
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=file://$REPO_ROOT/vitest.int.stub.mjs"

  local password app_password auth_password secret hmac_secret oidc_client_secret run_tag
  local database_url tls
  password="$(openssl rand -hex 24)"
  app_password="$(openssl rand -hex 24)"
  auth_password="$(openssl rand -hex 24)"
  secret="$(openssl rand -hex 32)"
  hmac_secret="$(openssl rand -hex 32)"
  oidc_client_secret="$(openssl rand -hex 32)"
  run_tag="$(openssl rand -hex 4)"
  mask "$password"
  mask "$app_password"
  mask "$auth_password"
  mask "$secret"
  mask "$hmac_secret"
  mask "$oidc_client_secret"
  mask "$run_tag"

  generate_tls
  start_postgres "$password"
  tls="sslmode=verify-full&sslrootcert=${STATE_DIR}/tls/ca.crt"
  # The owner (the image's superuser) only migrates; the API and the seed run
  # as the runtime roles, so RLS and the role split are exercised.
  database_url="postgres://tayzu:${password}@localhost:${PG_PORT}/tayzu_e2e?${tls}"
  # 048 design D1: db:migrate reads only MIGRATION_DATABASE_URL, never DATABASE_URL.
  export MIGRATION_DATABASE_URL="$database_url"

  log "waiting for PostgreSQL (verified TLS)"
  wait_for 60 postgres_accepts_tls || fail "PostgreSQL did not accept a verified TLS connection in time"

  log "applying migrations"
  (cd "$REPO_ROOT" && pnpm db:migrate)

  # The migrations create tayzu_app and tayzu_auth without a password
  # (design D15 of 001); this throwaway database gives them random ones, over
  # the container's local socket, never on a command line.
  printf "ALTER ROLE tayzu_app PASSWORD '%s';\nALTER ROLE tayzu_auth PASSWORD '%s';\n" \
    "$app_password" "$auth_password" |
    docker exec -i "$PG_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U tayzu -d tayzu_e2e >/dev/null
  export DATABASE_URL="postgres://tayzu_app:${app_password}@localhost:${PG_PORT}/tayzu_e2e?${tls}"
  export AUTH_DATABASE_URL="postgres://tayzu_auth:${auth_password}@localhost:${PG_PORT}/tayzu_e2e?${tls}"

  # The API, the stub, the proxy and the seed run with the production
  # configuration (design D16).
  export NODE_ENV=production
  # Node verifies the proxy's certificate (the API's discovery, JWKS and token
  # calls to the stub) against the run's CA.
  export NODE_EXTRA_CA_CERTS="$STATE_DIR/tls/node-ca.crt"
  export BETTER_AUTH_SECRET="$secret"
  # Q93 of 043: keys the per-recipient caps; random per run, never printed.
  export IDENTITY_TOKEN_HMAC_SECRET="$hmac_secret"
  # Q38: the public origin is the proxy's, over https.
  export BETTER_AUTH_URL="https://localhost:${APP_PORT}"
  export ALLOWED_ORIGINS="https://localhost:${APP_PORT}"
  # Must be one of ALLOWED_ORIGINS, port included.
  export INVITATION_LINK_BASE_URL="https://localhost:${APP_PORT}"
  export PASSWORD_RESET_LINK_BASE_URL="https://localhost:${APP_PORT}"
  # 044 D17: the public identity routes the accept and reset pages call. The
  # sender is non-sending (EMAIL_PROVIDER=none below); the seed captures the
  # links with the recording sender instead.
  export MOUNT_IDENTITY_ROUTES="true"
  export EMAIL_PROVIDER=none
  # The OIDC stub stands in for Visma Connect, behind the proxy's second port.
  # The stub is served at 127.0.0.1, a different site from the app at localhost, as Visma
  # Connect is in production: its form_post callback then carries no SameSite=Lax cookie,
  # so Better Auth's origin check never sees a provider origin (003 Q92).
  export VISMA_CONNECT_DISCOVERY_URL="https://127.0.0.1:${OIDC_PORT}/.well-known/openid-configuration"
  export VISMA_CONNECT_CLIENT_ID="tayzu-e2e"
  export VISMA_CONNECT_CLIENT_SECRET="$oidc_client_secret"
  export E2E_OIDC_ISSUER="https://127.0.0.1:${OIDC_PORT}"
  export E2E_OIDC_STUB_PORT="$OIDC_STUB_PORT"
  export E2E_OIDC_SUBJECT="e2e-visma-connect-${run_tag}"
  export E2E_OIDC_EMAIL="e2e-visma-connect-${run_tag}@example.test"
  export CERBOS_ADDRESS
  export PORT="$API_PORT"
  export HOST="127.0.0.1"
  # Q41 of 002: an explicit opt-out; the throwaway stack has no OTLP collector.
  export TAYZU_TELEMETRY_DISABLED="true"

  log "starting the OIDC stub"
  start_background oidc-stub pnpm --dir "$REPO_ROOT" exec tsx scripts/ci/e2e-oidc-stub.ts

  log "starting the TLS proxy"
  start_background proxy pnpm --dir "$REPO_ROOT" exec tsx scripts/ci/e2e-tls-proxy.ts \
    --cert "$STATE_DIR/tls/proxy-chain.crt" --key "$STATE_DIR/tls/proxy.key" \
    --route "${APP_PORT}=http://127.0.0.1:${API_PORT}" \
    --route "${OIDC_PORT}=http://127.0.0.1:${OIDC_STUB_PORT}"
  if ! wait_for 60 https_ok "$VISMA_CONNECT_DISCOVERY_URL"; then
    tail -n 50 "$STATE_DIR/oidc-stub.out" "$STATE_DIR/proxy.out" >&2 || true
    fail "the OIDC stub did not answer through the TLS proxy in time"
  fi

  # 003 design D9: the Vite output of the build above, served by apps/api.
  export WEB_DIST_DIR="$REPO_ROOT/apps/web/dist"

  log "starting apps/api"
  start_background api pnpm --dir "$REPO_ROOT" --filter @tayzu/api start
  if ! wait_for 60 curl -sf "http://127.0.0.1:${API_PORT}/healthz"; then
    tail -n 50 "$STATE_DIR/api.out" >&2 || true
    fail "apps/api did not become healthy in time"
  fi
  wait_for 30 https_ok "https://localhost:${APP_PORT}/healthz" ||
    fail "apps/api did not answer through the TLS proxy in time"

  log "seeding the e2e tenants"
  # The seed holds both runtime roles: DATABASE_URL (tayzu_app) and
  # AUTH_DATABASE_URL (tayzu_auth), with a fixed CI operator id (Q116 of 043).
  (cd "$REPO_ROOT" && TAYZU_OPERATOR_ID="ci:e2e-seed" pnpm exec tsx apps/web/e2e/fixtures/seed.ts)
  log "stack is up at https://localhost:${APP_PORT}"
}

run_tests() {
  [ -f "$STATE_DIR/seed.json" ] || fail "run 'e2e.sh up' first (no seed file)"
  (cd "$REPO_ROOT" && pnpm --filter @tayzu/web e2e)
}

# Stops the process group whose leader's pid is in $STATE_DIR/$1.pid.
stop_background() {
  local file="$STATE_DIR/$1.pid"
  if [ -f "$file" ]; then
    local pid
    pid="$(cat "$file")"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    rm -f "$file"
  fi
}

down() {
  stop_background proxy
  stop_background api
  stop_background oidc-stub
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  log "stack stopped"
}

# `pnpm ci:local` counts exit 77 as an explicit SKIP (scripts/ci/local.sh).
if ! docker info >/dev/null 2>&1; then
  echo "e2e: docker is not available; the e2e stack cannot run here" >&2
  exit 77
fi

case "${1:-}" in
  up) up ;;
  test) run_tests ;;
  down) down ;;
  all)
    trap down EXIT
    up
    run_tests
    # A green run leaves no seeded credentials or links behind; a failed one
    # keeps them (0600 in a 0700 directory) next to the report.
    rm -f "$STATE_DIR/seed.json"
    ;;
  *)
    echo "usage: e2e.sh up|test|down|all" >&2
    exit 2
    ;;
esac
