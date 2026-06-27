#!/usr/bin/env bash
# Build the agent binaries with the OFFICIAL portable Bun — never whatever `bun` is
# on PATH. A distro-packaged bun is dynamically linked to the build host's system
# libraries (system ICU, libatomic, …), and `bun build --compile` embeds that
# runtime, so the resulting agent inherits those deps and won't run on a host that
# lacks the exact versions (e.g. TrueNAS: missing libicui18n.so.78). The official
# release statically bundles ICU and targets old glibc, so the linux output needs
# only base glibc (libc/libm/libpthread/libdl/ld-linux) — present everywhere.
#
# Usage: build-agent.sh [linux|mac|windows]   (no arg = all)
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.3.10}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLCHAIN="$ROOT/.toolchain/bun-$BUN_VERSION"
BUN="$TOOLCHAIN/bun"
ENTRY="apps/server/src/index.ts"

# Fetch + cache the pinned official bun (host is linux-x64; cross-targets are
# downloaded by bun itself at compile time).
if [ ! -x "$BUN" ]; then
    echo "Fetching official bun $BUN_VERSION → $TOOLCHAIN"
    mkdir -p "$TOOLCHAIN"
    tmp="$(mktemp -d)"
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o "$tmp/bun.zip"
    unzip -q "$tmp/bun.zip" -d "$tmp"
    mv "$tmp/bun-linux-x64/bun" "$BUN"
    chmod +x "$BUN"
    rm -rf "$tmp"
fi

cd "$ROOT"
mkdir -p dist

# Build the web SPA and embed it into the binary. The web bundle is platform-agnostic,
# so do it once up front; each compile target then bundles the generated asset imports.
# Set SKIP_WEB=1 to reuse an existing apps/web/dist (e.g. fast iteration on the server).
if [ "${SKIP_WEB:-0}" != "1" ]; then
    echo "Building web SPA…"
    bun run --filter @central/web build
fi
echo "Embedding web assets…"
# Restore the committed (empty) generated file on exit so the working tree stays
# clean — the assets are already compiled into the binaries by then.
trap 'git checkout -- apps/server/src/web-assets.generated.ts 2>/dev/null || true' EXIT
bun run scripts/gen-web-assets.ts

# Output names carry the architecture (sc-agent-<os>-<arch>) so arm64 targets can be
# added later without colliding. Only x64 is built today.
build_linux()   { echo "Building linux x64 (glibc, portable)…"; "$BUN" build --compile --target=bun-linux-x64   "$ENTRY" --outfile dist/sc-agent-linux-x64; }
build_mac()     { echo "Building mac x64…";                     "$BUN" build --compile --target=bun-darwin-x64  "$ENTRY" --outfile dist/sc-agent-mac-x64; }
build_windows() { echo "Building windows x64…";                 "$BUN" build --compile --target=bun-windows-x64 "$ENTRY" --outfile dist/sc-agent-windows-x64.exe; }

case "${1:-all}" in
    linux)   build_linux ;;
    mac)     build_mac ;;
    windows) build_windows ;;
    all)     build_linux; build_mac; build_windows ;;
    *) echo "Unknown target: $1 (expected linux|mac|windows)" >&2; exit 1 ;;
esac

echo "Done."
