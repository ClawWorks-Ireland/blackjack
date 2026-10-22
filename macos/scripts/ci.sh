#!/usr/bin/env bash
# CI gate for the macOS app: the embedded engine is current, everything
# builds, the tests pass, and Swift and Node finish a seeded self-play run with
# identical results (so both really run the same engine).
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n==> %s\n' "$1"; }

step "embedded engine matches ../engine and ../agent"
node scripts/embed-engine.js --check

step "build (release)"
swift build -c release

step "test"
scripts/test.sh

step "self-play: Swift vs Node, 2000 rounds, seed ci"
swift_out="$(scripts/selfplay.sh 2000 ci)"
node_out="$(node ../agent/examples/selfplay.js --rounds 2000 --seed ci)"
echo "swift: $swift_out"
echo "node:  $node_out"
if [ "$swift_out" != "$node_out" ]; then
    echo "FAIL: Swift and Node disagree" >&2
    exit 1
fi

printf '\nCI: PASS\n'
