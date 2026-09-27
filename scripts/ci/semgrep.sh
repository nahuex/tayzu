#!/usr/bin/env bash
# Runs Semgrep OSS (SAST) from a pinned pip package, installed once into an
# isolated venv under CI_TOOLS_CACHE. Blocking on ERROR severity. Explicit
# registry rulesets only (never `--config auto`, which needs a Semgrep login
# and phones home for telemetry). Used by both ci.yml and
# scripts/ci/local.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

VERSION="1.178.0"
VENV_DIR="$CI_TOOLS_CACHE/semgrep/$VERSION"
BIN="$VENV_DIR/bin/semgrep"

if [ ! -x "$BIN" ]; then
  echo "semgrep: installing v$VERSION into $VENV_DIR"
  rm -rf "$VENV_DIR"
  if ! python3 -m venv "$VENV_DIR" 2>/dev/null; then
    rm -rf "$VENV_DIR"
    skip "semgrep: python3 venv module unavailable"
  fi
  if ! "$VENV_DIR/bin/pip" install --quiet "semgrep==$VERSION"; then
    rm -rf "$VENV_DIR"
    skip "semgrep v$VERSION could not be installed (PyPI unreachable)"
  fi
fi

exec "$BIN" scan \
  --config p/typescript \
  --config p/nodejs \
  --config p/secrets \
  --metrics=off \
  --error \
  --severity ERROR \
  .
