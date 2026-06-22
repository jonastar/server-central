#!/usr/bin/env bash
# Verify changes the way Claude (or you) would before trusting a diff: typecheck
# every workspace, then run the server test suite. Runs all steps even if an early
# one fails, then reports a summary and exits non-zero if anything failed — so one
# run surfaces every problem instead of stopping at the first.
#
# Usage: scripts/check.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

failed=()

run() {
  local name="$1"
  shift
  echo
  echo "==> $name"
  if "$@"; then
    echo "    ok: $name"
  else
    echo "    FAILED: $name"
    failed+=("$name")
  fi
}

run "typecheck" bun run typecheck
run "server tests" bun run --filter @central/server test

echo
echo "================ summary ================"
if [ ${#failed[@]} -eq 0 ]; then
  echo "all checks passed"
  exit 0
fi

echo "failures:"
for f in "${failed[@]}"; do
  echo "  - $f"
done
exit 1
