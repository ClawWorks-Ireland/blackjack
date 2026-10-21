#!/usr/bin/env bash
# Build all targets in release configuration.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "==> swift build -c release"
swift build -c release "$@"
echo "==> build OK"
