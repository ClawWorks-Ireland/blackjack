#!/usr/bin/env bash
# Run the live table server (server/server.js) as a launchd user agent on
# this Mac, so it starts at login and restarts if it stops.
#
#   server/service.sh install [host]   write ~/Library/LaunchAgents/<label>.plist and start it
#                                      (host: the address to listen on, default 192.168.4.43)
#   server/service.sh restart          restart it (after pulling new code)
#   server/service.sh status           is it loaded, running, listening?
#   server/service.sh uninstall        stop it and remove the plist
#
# Output goes to server/data/server.log. The macOS firewall must allow the
# Node binary (System Settings > Network > Firewall, or socketfilterfw);
# re-check after `brew upgrade node`, since the binary's path changes.
set -euo pipefail

LABEL=com.clawworks.blackjack-tables
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE=/opt/homebrew/opt/node/bin/node   # Homebrew's stable path: survives node upgrades
PORT=8787
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    HOST="${2:-192.168.4.43}"
    [ -x "$NODE" ] || { echo "no node at $NODE" >&2; exit 1; }
    mkdir -p "$ROOT/server/data" "$(dirname "$PLIST")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/server/server.js</string>
    <string>--host</string><string>$HOST</string>
    <string>--port</string><string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <!-- Restart whenever it stops: also covers the network address not being up yet at login. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$ROOT/server/data/server.log</string>
  <key>StandardErrorPath</key><string>$ROOT/server/data/server.log</string>
</dict>
</plist>
EOF
    plutil -lint "$PLIST" >/dev/null
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "installed $LABEL: http://$HOST:$PORT/ (log: server/data/server.log)"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "restarted $LABEL"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid|last exit code|runs) ' || true
    else
      echo "$LABEL is not loaded"
    fi
    lsof -nP -iTCP:$PORT -sTCP:LISTEN || echo "nothing listening on port $PORT"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL"
    ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
