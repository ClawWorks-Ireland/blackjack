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
#   server/service.sh install-agents [host] [table]   also run a local-model player (agent/local-player.js)
#                                      at that table (default the practice table, 2), always on
#   server/service.sh uninstall-agents
#   server/service.sh install-poker-agent [host] [table]   an LLM poker player (agent/poker-player.js)
#                                      at that poker table (default p1, the one with bots), always on
#   server/service.sh uninstall-poker-agent
#
# Output goes to server/data/server.log. The macOS firewall must allow the
# Node binary (System Settings > Network > Firewall, or socketfilterfw);
# re-check after `brew upgrade node`, since the binary's path changes.
set -euo pipefail

LABEL=com.clawworks.blackjack-tables
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
AGENTS=com.clawworks.blackjack-agents
AGENTS_PLIST="$HOME/Library/LaunchAgents/$AGENTS.plist"
POKER=com.clawworks.poker-agent
POKER_PLIST="$HOME/Library/LaunchAgents/$POKER.plist"
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
  install-agents)
    HOST="${2:-192.168.4.43}"
    TABLE="${3:-2}"
    mkdir -p "$ROOT/server/data" "$(dirname "$AGENTS_PLIST")"
    cat > "$AGENTS_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AGENTS</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/agent/local-player.js</string>
    <string>--url</string><string>http://$HOST:$PORT</string>
    <string>--table</string><string>$TABLE</string>
    <string>--name</string><string>Gemma (local)</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$ROOT/server/data/agents.log</string>
  <key>StandardErrorPath</key><string>$ROOT/server/data/agents.log</string>
</dict>
</plist>
PLIST
    plutil -lint "$AGENTS_PLIST" >/dev/null
    launchctl bootout "$DOMAIN/$AGENTS" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$AGENTS_PLIST"
    echo "installed $AGENTS: a local-model player at table $TABLE on http://$HOST:$PORT/ (log: server/data/agents.log)"
    ;;
  install-poker-agent)
    HOST="${2:-192.168.4.43}"
    TABLE="${3:-p1}"
    mkdir -p "$ROOT/server/data" "$(dirname "$POKER_PLIST")"
    cat > "$POKER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$POKER</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/agent/poker-player.js</string>
    <string>--url</string><string>http://$HOST:$PORT</string>
    <string>--table</string><string>$TABLE</string>
    <string>--name</string><string>Gemma (poker)</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$ROOT/server/data/poker-agent.log</string>
  <key>StandardErrorPath</key><string>$ROOT/server/data/poker-agent.log</string>
</dict>
</plist>
PLIST
    plutil -lint "$POKER_PLIST" >/dev/null
    launchctl bootout "$DOMAIN/$POKER" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$POKER_PLIST"
    echo "installed $POKER: an LLM poker player at table $TABLE on http://$HOST:$PORT/ (log: server/data/poker-agent.log)"
    ;;
  uninstall-poker-agent)
    launchctl bootout "$DOMAIN/$POKER" 2>/dev/null || true
    rm -f "$POKER_PLIST"
    echo "removed $POKER"
    ;;
  uninstall-agents)
    launchctl bootout "$DOMAIN/$AGENTS" 2>/dev/null || true
    rm -f "$AGENTS_PLIST"
    echo "removed $AGENTS"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "restarted $LABEL"
    for L in "$AGENTS" "$POKER"; do
      if launchctl print "$DOMAIN/$L" >/dev/null 2>&1; then launchctl kickstart -k "$DOMAIN/$L"; echo "restarted $L"; fi
    done
    ;;
  status)
    for L in "$LABEL" "$AGENTS" "$POKER"; do
      if launchctl print "$DOMAIN/$L" >/dev/null 2>&1; then
        echo "$L:"; launchctl print "$DOMAIN/$L" | grep -E '^\s*(state|pid|last exit code|runs) ' | head -4 || true
      else
        echo "$L is not loaded"
      fi
    done
    lsof -nP -iTCP:$PORT -sTCP:LISTEN || echo "nothing listening on port $PORT"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL"
    ;;
  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
