#!/usr/bin/env bash
# Play the blackjack game in a REAL, visible browser via playwright-cli
# (its own Chromium; this works from the agent sandbox, where
# chromium.launch({headless:false}) hangs). Follows the in-game coach's hint
# each hand, uses chips + Rebet, and saves a screenshot per hand.
# Usage: qa/live_play.sh <snapshotDir> <outDir> [hands=5] [port=8765]
# The user can watch by loading http://127.0.0.1:<port>/index.html in the
# dashboard Browser panel (web-preview marker).
set -u
SNAP=$1; OUT=$2; HANDS=${3:-5}; PORT=${4:-8765}
mkdir -p "$OUT"
p() { timeout 30 playwright-cli "$@" 2>&1; }
ref() { grep -o "button \"$1[^\"]*\" \(\[active\] \)\?\[ref=[a-z0-9]*" | head -1 | grep -o 'ref=[a-z0-9]*$' | cut -d= -f2; }

if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/index.html"; then
  (cd "$SNAP" && nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &)
  sleep 2
fi
if [ -n "${ATTACHED:-}" ]; then   # driving the user's own Chrome tab (attach --extension)
  p video-show-actions >/dev/null
  if [ -n "${COUNT:-}" ]; then   # show the count panel and set a $UNIT base unit
    p eval "() => { if (document.getElementById('count-panel').hidden) document.getElementById('count-toggle').click(); const u = document.getElementById('bet-unit'); u.value = '${UNIT:-5}'; u.dispatchEvent(new Event('input',{bubbles:true})); u.dispatchEvent(new Event('change',{bubbles:true})); }" >/dev/null
  fi
  if [ -n "${SPOTS:-}" ]; then   # play N betting spots (F5); the bet box is per spot
    p eval "() => { const r = document.querySelector('input[name=spots][value=\"${SPOTS}\"]'); if (r) { r.checked = true; r.dispatchEvent(new Event('change',{bubbles:true})); } return !!r; }" >/dev/null
  fi
else
  p open "http://127.0.0.1:$PORT/index.html" >/dev/null || p goto "http://127.0.0.1:$PORT/index.html" >/dev/null
  p eval "() => { localStorage.clear(); location.reload(); }" >/dev/null; sleep 1
  p video-start; p video-show-actions >/dev/null
fi

# Rounds counter from the stats panel: the game's own proof a round finished.
rounds() { echo "$1" | grep -A1 'term \[ref=[a-z0-9]*\]: Rounds' | tail -1 | sed 's/.*\]: //' | tr -dc '0-9'; }
# Wait (up to ~15s) until the table is idle (Rebet/Deal clickable) or awaiting a decision.
settle() {
  local s
  for _ in $(seq 1 30); do
    s=$(p snapshot)
    if echo "$s" | grep -q 'button "Hit H" \(\[active\] \)\?\[ref\|button "No insurance\|button "No even money\|button "Rebet \$[^"]*" \(\[active\] \)\?\[ref\|button "Deal Enter" \(\[active\] \)\?\[ref'; then
      echo "$s"; return 0
    fi
    sleep 0.5
  done
  echo "$s"; return 1
}

played=0; attempts=0; skipped=0
while [ "$played" -lt "$HANDS" ] && [ "$attempts" -lt $((HANDS + 5)) ]; do
  attempts=$((attempts + 1)); i=$((played + 1))
  s=$(settle); before=$(rounds "$s")
  r=$(echo "$s" | ref "Rebet \$")
  # Enter = the game's Rebet shortcut. Keys work in a background tab; clicks wait
  # for animation frames, which Chrome pauses when the tab is hidden.
  if echo "$s" | grep -q 'button "Hit H" \(\[active\] \)\?\[ref\|button "No insurance'; then :   # hand already live
  elif [ -n "${COUNT:-}" ]; then
    # Counted play: bet exactly what the game's count panel suggests, then deal from the bet box.
    sug=$(p eval "() => { const t = document.getElementById('suggest-text').textContent; const m = t.match(/\\u0024([0-9,.]+)/); const amt = m ? m[1].replace(/,/g,'') : ''; const tc = (document.getElementById('count-true')||{}).textContent; const b = document.getElementById('bet'); if (amt) { b.value = amt; b.dispatchEvent(new Event('input', {bubbles:true})); } b.focus(); return amt + ' @TC ' + tc; }" | sed -n 2p | tr -d '"')
    echo "hand $i bet: \$$sug"
    p press Enter >/dev/null
  elif [ -n "$r" ] && [ -n "${ATTACHED:-}" ]; then
    # Enter only deals from the bet box; on a focused button it presses that button
    # (it once toggled Coach notes off). Put focus in the bet box first.
    p eval "() => { document.getElementById('bet').focus(); }" >/dev/null; p press Enter >/dev/null
  elif [ -n "$r" ]; then p click "$r" >/dev/null
  else
    p click "$(echo "$s" | ref "Clear bet")" >/dev/null
    p click "$(echo "$s" | ref "Add \$25")" >/dev/null
    p click "$(echo "$s" | ref "Deal")" >/dev/null
  fi
  sleep 1   # let the deal render before reading state
  for step in $(seq 1 24); do   # up to 3 spots with splits
    s=$(settle)
    if echo "$s" | grep -q 'button "No insurance\|button "No even money'; then
      if [ -n "${COUNT:-}" ]; then
        tc=$(p eval "() => document.getElementById('count-true').textContent" | sed -n 2p | tr -d '"+')
        if awk -v x="$tc" 'BEGIN{exit !(x+0 >= 3)}'; then echo "hand $i: insurance at TC $tc -> take"; p press i >/dev/null
        else p press n >/dev/null; fi
      else p press n >/dev/null; fi
      continue
    fi
    echo "$s" | grep -q 'button "Hit H" \(\[active\] \)\?\[ref' || break   # idle again: round over
    p press g >/dev/null; sleep 0.4
    hint=$(p snapshot | grep -o -E "(Basic strategy|Count play): [A-Za-z]+[^\"]*" | head -1)
    act=$(echo "$hint" | sed -E 's/^[^:]*: ([A-Za-z]+).*/\1/')   # first action only; later text may name the basic play
    case "$act" in Surrender) k=r;; Stand) k=s;; Double) k=d;; Split) k=p;; *) k=h;; esac
    echo "hand $i step $step: $hint -> $k"
    p press "$k" >/dev/null
  done
  s=$(settle); after=$(rounds "$s")
  if [ -z "$before" ] || [ -z "$after" ] || [ "$after" -le "$before" ]; then
    skipped=$((skipped + 1)); echo "attempt $attempts: NOT DEALT (rounds ${before:-?} -> ${after:-?}), retrying"; continue
  fi
  played=$((played + 1))
  echo "hand $i: $(echo "$s" | grep -o 'status \[ref=[a-z0-9]*\]: .*' | head -1) | bankroll $(echo "$s" | grep -A1 '"Bankroll:"' | grep -o '\$[0-9,.]*' | head -1) | rounds $before -> $after"
  # Screenshots force a repaint of the user's tab (visible white flash): skip when attached.
  [ -n "${ATTACHED:-}" ] && [ -z "${SHOTS:-}" ] && continue
  shot=$(p screenshot | grep -o 'page-[^ )]*\.png' | tail -1)
  [ -n "$shot" ] && cp "$PLAYWRIGHT_MCP_OUTPUT_DIR/$shot" "$OUT/hand-$i.png"
done
echo "played $played of $HANDS (skipped deals: $skipped)"
[ -z "${ATTACHED:-}" ] && p video-chapter "Done" >/dev/null && vid=$(p video-stop | grep -o '[^ ()]*\.webm' | tail -1); echo "video: ${vid:-none}"
echo "accuracy: $(p snapshot | grep -A1 'Strategy accuracy' | tail -1 | sed 's/.*: //')"
