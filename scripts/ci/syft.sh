#!/usr/bin/env bash
# Generates an SPDX JSON SBOM of the pnpm dependency tree with Syft, from a
# pinned release binary downloaded once into CI_TOOLS_CACHE and verified by
# sha256. Non-blocking (R14): a failure here must never fail the caller.
# Usage: syft.sh [output-path]. Defaults to a path outside the repo so a
# local run never leaves an untracked file in the working tree.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

VERSION="1.52.0"
OS="$(host_os)"
ARCH="$(host_arch)"

case "$OS-$ARCH" in
  linux-amd64)
    SHA256="caeedb81fb0491615f1ebd1761e4145d41ee86dd2cc7bf80669f9f5ad9d6133d"
    ;;
  linux-arm64)
    SHA256="c46d5e4c28e12aa4c5becfaa343ef1c7f89045b6b895f2c21d471c62db09c706"
    ;;
  darwin-amd64)
    SHA256="56975f5d7ffa9846a1eaf64330647841b878097bc7e3730cb9325f93add96917"
    ;;
  darwin-arm64)
    SHA256="014d561b6d13059124155f74a6c5a9a99501f5e209313638dd884f39eb418ee6"
    ;;
  *)
    skip "syft: unsupported platform $OS-$ARCH"
    ;;
esac

BIN_DIR="$CI_TOOLS_CACHE/syft/$VERSION"
BIN="$BIN_DIR/syft"
OUT="${1:-$CI_TOOLS_CACHE/sbom/sbom.spdx.json}"
mkdir -p "$(dirname "$OUT")"

if [ ! -x "$BIN" ]; then
  mkdir -p "$BIN_DIR"
  TMP="$(mktemp -d)"
  ARCHIVE="$TMP/syft.tar.gz"
  echo "syft: downloading v$VERSION ($OS/$ARCH) into $BIN_DIR"
  if ! curl -fsSL -o "$ARCHIVE" \
    "https://github.com/anchore/syft/releases/download/v${VERSION}/syft_${VERSION}_${OS}_${ARCH}.tar.gz"; then
    rm -rf "$TMP"
    skip "syft v$VERSION could not be downloaded (network unavailable)"
  fi
  verify_sha256 "$ARCHIVE" "$SHA256"
  tar -xzf "$ARCHIVE" -C "$BIN_DIR" syft
  chmod +x "$BIN"
  rm -rf "$TMP"
fi

"$BIN" scan dir:. --source-name tayzu -o "spdx-json=$OUT"
echo "syft: SBOM written to $OUT"
