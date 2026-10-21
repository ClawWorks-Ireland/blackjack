#!/usr/bin/env bash
# Run the XCTest suite.
#
# XCTest ships with the full Xcode toolchain, not the bare Command Line Tools.
# If the active developer directory can't provide XCTest, fall back to an
# installed Xcode.app so `swift test` works on either setup.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! xcrun --find xctest >/dev/null 2>&1; then
    for candidate in \
        "${DEVELOPER_DIR:-}" \
        /Applications/Xcode.app/Contents/Developer \
        /Applications/Xcode-beta.app/Contents/Developer; do
        if [ -n "$candidate" ] && [ -d "$candidate/Platforms/MacOSX.platform" ]; then
            export DEVELOPER_DIR="$candidate"
            echo "==> using Xcode toolchain for XCTest: $DEVELOPER_DIR"
            break
        fi
    done
fi

echo "==> swift test"
swift test "$@"
