#!/usr/bin/env bash
# Idempotently starts a local Cerbos PDP container for development, mirroring
# compose.yaml's `cerbos` service (config/cerbos.yaml: disk driver over
# `policies/`, watchForChanges: false, strictEvaluation: true — design D7,
# openspec/changes/002-auth-and-rbac/design.md). Starts dockerd first if it
# is installed but not running. No secrets are involved: the image is public
# and the config carries no credentials.
#
# Called from .claude/hooks/session-start.sh in the cloud sandbox, after its
# PostgreSQL start-up step. On a laptop, use `docker compose up -d --wait`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

CERBOS_IMAGE='ghcr.io/cerbos/cerbos@sha256:4b9d3b58c4f11c1b8953bc798d8d086e64f276882253ab169625fddc7f432515'
CERBOS_CONTAINER='tayzu-cerbos'

wait_for_cerbos_health() {
  local tries=30
  while [ "$tries" -gt 0 ]; do
    if curl -sf -o /dev/null http://localhost:3592/_cerbos/health; then
      return 0
    fi
    tries=$((tries - 1))
    sleep 1
  done
  return 1
}

if ! command -v docker >/dev/null 2>&1; then
  echo "start-cerbos: Docker not installed, skipping." >&2
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  dockerd >/dev/null 2>&1 &
  disown
  tries=30
  while [ "$tries" -gt 0 ] && ! docker info >/dev/null 2>&1; do
    tries=$((tries - 1))
    sleep 1
  done
fi

if ! docker info >/dev/null 2>&1; then
  echo "start-cerbos: Docker daemon unavailable, skipping." >&2
  exit 0
fi

if [ "$(docker inspect -f '{{.State.Running}}' "$CERBOS_CONTAINER" 2>/dev/null || echo "")" = "true" ]; then
  : # Already running; nothing to do.
elif docker inspect "$CERBOS_CONTAINER" >/dev/null 2>&1; then
  docker start "$CERBOS_CONTAINER" >/dev/null
else
  docker run -d --name "$CERBOS_CONTAINER" \
    -p 127.0.0.1:3592:3592 -p 127.0.0.1:3593:3593 \
    -e CERBOS_NO_TELEMETRY=1 \
    -v "$PROJECT_DIR/policies:/policies:ro" \
    -v "$PROJECT_DIR/config/cerbos.yaml:/config/.cerbos.yaml:ro" \
    "$CERBOS_IMAGE" server --config=/config/.cerbos.yaml >/dev/null
fi

if ! wait_for_cerbos_health; then
  echo "start-cerbos: Cerbos did not become healthy in time." >&2
  exit 1
fi
