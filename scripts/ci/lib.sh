#!/usr/bin/env bash
# Shared helpers for the pinned-tool scripts in this directory
# (gitleaks.sh, semgrep.sh, syft.sh). Each of those scripts downloads or
# installs its pinned version into CI_TOOLS_CACHE (outside the repo) the
# first time it runs, verifies it, and then runs it. A tool that truly
# cannot be fetched (no network, unsupported platform) exits with
# SKIP_EXIT_CODE and an explicit message on stderr; it never fails silently
# and never passes silently either (local.sh reports every skip).

set -euo pipefail

CI_TOOLS_CACHE="${CI_TOOLS_CACHE:-$HOME/.cache/tayzu-ci-tools}"
SKIP_EXIT_CODE=77

skip() {
  echo "SKIP: $*" >&2
  exit "$SKIP_EXIT_CODE"
}

verify_sha256() {
  local file="$1" expected="$2" actual
  actual="$(sha256sum "$file" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "ERROR: checksum mismatch for $file (expected $expected, got $actual)" >&2
    exit 1
  fi
}

host_os() { uname -s | tr '[:upper:]' '[:lower:]'; }

host_arch() {
  case "$(uname -m)" in
    x86_64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) uname -m ;;
  esac
}
