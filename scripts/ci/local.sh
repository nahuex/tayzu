#!/usr/bin/env bash
# `pnpm ci:local`: runs the same checks as .github/workflows/ci.yml, in the
# same order, against the local sandbox. gitleaks, Semgrep and Syft download
# their pinned version into CI_TOOLS_CACHE (outside the repo) the first
# time; if a tool truly cannot run here (no network, unsupported platform),
# its step prints an explicit SKIP and is not counted as a failure. The DAST
# step (scripts/ci/dast.sh) needs Docker and skips the same way without it.
# Every other step failure is fatal, Syft included, as in CI, except the
# steps run with advisory_step, which CI marks continue-on-error: their
# failure prints a WARNING and does not fail the run.

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

# A non-blocking step (continue-on-error in CI): a failure is reported as a
# WARNING and never sets FAILED.
advisory_step() {
  local desc="$1"
  shift
  echo
  echo "== $desc (non-blocking) =="
  if "$@"; then
    return 0
  fi
  echo "WARNING (non-blocking): $desc reported findings"
}

# The e2e suite needs Docker (e2e.sh exits 77 without it) and the Playwright
# Chromium (preinstalled at /opt/pw-browsers in the sandbox, or installed by
# `pnpm --filter @tayzu/web exec playwright install chromium`).
e2e_suite() {
  local browsers="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
  if ! compgen -G "$browsers/chromium*" >/dev/null; then
    echo "SKIP: no Playwright chromium under $browsers"
    return "$SKIP_EXIT_CODE"
  fi
  bash "$SCRIPT_DIR/e2e.sh" all
}

step "lint" pnpm lint
step "format:check" pnpm format:check
step "typecheck" pnpm typecheck
step "web build" pnpm --filter @tayzu/web build
step "web bundle check" pnpm --filter @tayzu/web check:bundle
step "gitleaks (web dist)" bash "$SCRIPT_DIR/gitleaks.sh" dir apps/web/dist
step "policy:compile" pnpm policy:compile
step "test" pnpm test
step "contract:check" pnpm contract:check
step "otel-smoke-check" pnpm otel-smoke-check
step "pnpm audit --prod --audit-level=high" pnpm audit --prod --audit-level=high
advisory_step "pnpm audit --audit-level=critical" pnpm audit --audit-level=critical
step "gitleaks" bash "$SCRIPT_DIR/gitleaks.sh"
step "semgrep" bash "$SCRIPT_DIR/semgrep.sh"
step "dast (OWASP ZAP baseline)" bash "$SCRIPT_DIR/dast.sh" all
step "e2e (Playwright, Chromium)" e2e_suite

step "syft (SBOM)" bash "$SCRIPT_DIR/syft.sh"

echo
if [ "$FAILED" -ne 0 ]; then
  echo "ci:local FAILED"
  exit 1
fi
echo "ci:local passed"
