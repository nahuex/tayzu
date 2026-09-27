#!/usr/bin/env bash
# Runs gitleaks (secret scanning) from a pinned release binary, downloaded
# once into CI_TOOLS_CACHE and verified by sha256. Blocking: any leak fails
# the script. Used by both ci.yml and scripts/ci/local.sh (single source of
# truth for the pinned version).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

VERSION="8.30.1"
OS="$(host_os)"
ARCH_RAW="$(uname -m)"

case "$OS-$ARCH_RAW" in
  linux-x86_64)
    ASSET="linux_x64"
    SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
    ;;
  linux-aarch64 | linux-arm64)
    ASSET="linux_arm64"
    SHA256="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"
    ;;
  darwin-x86_64)
    ASSET="darwin_x64"
    SHA256="dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709"
    ;;
  darwin-arm64)
    ASSET="darwin_arm64"
    SHA256="b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"
    ;;
  *)
    skip "gitleaks: unsupported platform $OS-$ARCH_RAW"
    ;;
esac

BIN_DIR="$CI_TOOLS_CACHE/gitleaks/$VERSION"
BIN="$BIN_DIR/gitleaks"

if [ ! -x "$BIN" ]; then
  mkdir -p "$BIN_DIR"
  TMP="$(mktemp -d)"
  ARCHIVE="$TMP/gitleaks.tar.gz"
  echo "gitleaks: downloading v$VERSION ($ASSET) into $BIN_DIR"
  if ! curl -fsSL -o "$ARCHIVE" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_${ASSET}.tar.gz"; then
    rm -rf "$TMP"
    skip "gitleaks v$VERSION could not be downloaded (network unavailable)"
  fi
  verify_sha256 "$ARCHIVE" "$SHA256"
  tar -xzf "$ARCHIVE" -C "$BIN_DIR" gitleaks
  chmod +x "$BIN"
  rm -rf "$TMP"
fi

exec "$BIN" detect --source . --config .gitleaks.toml --redact
