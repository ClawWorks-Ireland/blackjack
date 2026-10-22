#!/usr/bin/env bash
# Build the SwiftUI app (on the shared engine), package it into a .app bundle, and launch it.
#
# SwiftPM produces a bare executable; macOS needs a .app bundle (with Info.plist)
# for a proper windowed app. This script assembles that bundle under
# .build/BlackjackApp.app and opens it.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="release"
echo "==> building BlackjackApp ($CONFIG)"
swift build -c "$CONFIG" --product BlackjackApp >/dev/null
BIN_DIR="$(swift build -c "$CONFIG" --product BlackjackApp --show-bin-path)"
EXE="$BIN_DIR/BlackjackApp"

APP=".build/BlackjackApp.app"
echo "==> packaging $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$EXE" "$APP/Contents/MacOS/BlackjackApp"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>            <string>Blackjack</string>
    <key>CFBundleDisplayName</key>     <string>Blackjack</string>
    <key>CFBundleExecutable</key>      <string>BlackjackApp</string>
    <key>CFBundleIdentifier</key>      <string>dev.delmarolivier.blackjack</string>
    <key>CFBundleVersion</key>         <string>0.1.0</string>
    <key>CFBundleShortVersionString</key> <string>0.1.0</string>
    <key>CFBundlePackageType</key>     <string>APPL</string>
    <key>LSMinimumSystemVersion</key>  <string>13.0</string>
    <key>NSHighResolutionCapable</key> <true/>
    <key>NSPrincipalClass</key>        <string>NSApplication</string>
</dict>
</plist>
PLIST

echo "==> launching $APP"
open "$APP"
