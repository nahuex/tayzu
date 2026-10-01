#!/usr/bin/env bash
# `pnpm policy:compile`: compiles and tests the Cerbos policy tree in
# `policies/` against the pinned Cerbos image (design D7,
# openspec/changes/002-auth-and-rbac). Runs cleanly against an empty tree
# (nothing authored yet) and fails non-zero on a compile or test error, which
# is what makes it a required CI gate (task 7.3). Image pinned by digest,
# the same as compose.yaml (ghcr.io/cerbos/cerbos:0.55.0).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

exec docker run --rm \
  -v "$REPO_ROOT/policies:/policies:ro" \
  ghcr.io/cerbos/cerbos@sha256:4b9d3b58c4f11c1b8953bc798d8d086e64f276882253ab169625fddc7f432515 compile /policies
