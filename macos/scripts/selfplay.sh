#!/usr/bin/env bash
# Run headless self-play through the shared engine.
#
# Usage: scripts/selfplay.sh [ROUNDS] [SEED]   (defaults: 10000 rounds, seed "selfplay")
set -euo pipefail
cd "$(dirname "$0")/.."

ROUNDS="${1:-10000}"
SEED="${2:-selfplay}"

swift build -c release --product blackjack-selfplay >/dev/null
BIN="$(swift build -c release --product blackjack-selfplay --show-bin-path)/blackjack-selfplay"
"$BIN" --rounds "$ROUNDS" --seed "$SEED"
