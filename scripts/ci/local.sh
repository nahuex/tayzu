#!/usr/bin/env bash
# `pnpm ci:local`: runs the same checks as .github/workflows/ci.yml, in the
# same order, against the local sandbox. gitleaks, Semgrep and Syft download
# their pinned version into CI_TOOLS_CACHE (outside the repo) the first
# time; if a tool truly cannot run here (no network, unsupported platform),
# its step prints an explicit SKIP and is not counted as a failure. Every
# other step failure is fatal. Syft is non-blocking, matching its
# `continue-on-error: true` step in CI.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

SKIP_EXIT_CODE=77
FAILED=0

step() {
  local desc="$1"
  shift
  echo
  echo "== $desc =="
  "$@"
  local code=$?
  if [ "$code" -eq 0 ]; then
    return 0
  elif [ "$code" -eq "$SKIP_EXIT_CODE" ]; then
    echo "SKIPPED: $desc"
  else
    echo "FAILED: $desc"
    FAILED=1
  fi
}

step "lint" pnpm lint
step "typecheck" pnpm typecheck
step "test" pnpm test
step "contract:check" pnpm contract:check
step "otel-smoke-check" pnpm otel-smoke-check
step "pnpm audit --prod --audit-level=high" pnpm audit --prod --audit-level=high
step "gitleaks" bash "$SCRIPT_DIR/gitleaks.sh"
step "semgrep" bash "$SCRIPT_DIR/semgrep.sh"

echo
echo "== syft (SBOM, non-blocking) =="
bash "$SCRIPT_DIR/syft.sh"
syft_code=$?
if [ "$syft_code" -eq "$SKIP_EXIT_CODE" ]; then
  echo "SKIPPED: syft"
elif [ "$syft_code" -ne 0 ]; then
  echo "syft failed (non-blocking, matches CI's continue-on-error: true)"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "ci:local FAILED"
  exit 1
fi
echo "ci:local passed"
