#!/usr/bin/env bash
# Play the F13 drills live in an attached Chrome tab (playwright-cli attach --extension=chrome).
# Flashcards: read the cards from their aria-labels, answer with the chart move
# (BlackjackStrategy.recommend) by pressing its key; every MISS-th card is answered
# wrong on purpose to show the feedback. Count drill: watch each card as it is
# flashed, keep my own Hi-Lo count, and type it in.
# Usage: qa/live_drills.sh [cards=20] [miss_every=7] [count_cards=26] [speed=0.5]
set -u
N=${1:-20}; MISS=${2:-7}; CN=${3:-26}; SPEED=${4:-0.5}
p() { timeout 40 playwright-cli "$@" 2>&1; }
ev() { p eval "$1" | sed -n 2p | tr -d '"'; }

ev "() => { const d = document.getElementById('drill'); if (!d.open) document.getElementById('drill-open').click(); document.getElementById('tab-flash').click(); return d.open; }" >/dev/null
sleep 0.5
i=0; while [ "$i" -lt "$N" ]; do i=$((i + 1))
  # Work out the chart move from the cards on screen.
  info=$(ev "() => {
    const parse = (el) => { const [r] = el.getAttribute('aria-label').split(' of '); const map = { ace: 'A', king: 'K', queen: 'Q', jack: 'J' }; return { rank: map[r] || r, suit: '♠' }; };
    const hand = [...document.querySelectorAll('#flash-hand .card')].map(parse);
    const upEl = document.querySelector('#flash-up .card') || document.getElementById('flash-up');
    const up = upEl.getAttribute('aria-label') ? parse(upEl) : { rank: upEl.textContent.replace(/[^0-9AJQK]/g, '').replace(/^1$/, '10'), suit: '♠' };
    const rules = { ...BlackjackStrategy.DEFAULT_RULES, lateSurrender: true };
    const mv = BlackjackStrategy.recommend(hand, up, { canDouble: true, canSplit: true, canSurrender: true }, rules).action;
    return hand.map((c) => c.rank).join(',') + ' vs ' + up.rank + ' -> ' + mv;
  }")
  move=${info##*-> }
  case "$move" in hit) k=h; alt=s;; stand) k=s; alt=h;; double) k=d; alt=h;; split) k=p; alt=h;; surrender) k=r; alt=h;; *) k=h; alt=s;; esac
  if [ "$MISS" -gt 0 ] && [ $((i % MISS)) -eq 0 ]; then k=$alt; tag="(deliberate miss)"; else tag=""; fi
  p press "$k" >/dev/null; sleep 0.6
  fb=$(ev "() => document.getElementById('flash-feedback').textContent.replace(/\s+/g, ' ').trim()")
  echo "card $i: $info, pressed $k $tag | $fb"
  sleep 0.9
  ev "() => { const b = document.getElementById('flash-next'); if (b && !b.disabled && !b.hidden) b.click(); return 1; }" >/dev/null
  sleep 0.3
done
echo "flash score: $(ev "() => document.getElementById('flash-score').textContent.replace(/\s+/g, ' ').trim()")"

# ---- count drill ----
ev "() => { document.getElementById('tab-count').click(); const s = document.getElementById('cd-size'), v = document.getElementById('cd-speed'); for (const [el, val] of [[s, '$CN'], [v, '$SPEED']]) { if (!el) continue; const o = [...el.options].find((x) => x.value === val) || el.options[0]; el.value = o.value; el.dispatchEvent(new Event('change', { bubbles: true })); } document.getElementById('cd-start').click(); return 1; }" >/dev/null
# Collect the flashed cards in the page itself so none are missed between polls.
ev "() => { window.__seen = {}; const el = document.getElementById('cd-card'), pr = document.getElementById('cd-progress'); const grab = () => { const c = el.querySelector('.card'); const n = (pr.textContent.match(/\\d+/) || [])[0]; if (c && n) window.__seen[n] = c.getAttribute('aria-label'); }; const mo = new MutationObserver(grab); mo.observe(el, { childList: true, subtree: true }); mo.observe(pr, { childList: true, subtree: true, characterData: true }); grab(); return 1; }" >/dev/null
for _ in $(seq 1 120); do
  done_=$(ev "() => !document.getElementById('cd-form').hidden && !document.getElementById('cd-form').closest('[hidden]')")
  [ "$done_" = "true" ] && break
  sleep 0.5
done
mine=$(ev "() => { const v = (l) => { const r = l.split(' of ')[0].toUpperCase(); if (['A','ACE','K','KING','Q','QUEEN','J','JACK','10'].includes(r)) return -1; return Number(r) <= 6 ? 1 : 0; }; const ls = Object.values(window.__seen); return ls.length + ' ' + ls.reduce((s, l) => s + v(l), 0); }")
seen=${mine% *}; count=${mine#* }
echo "count drill: saw $seen cards, my Hi-Lo count $count"
ev "() => { const g = document.getElementById('cd-guess'); g.value = '$count'; g.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('cd-form').requestSubmit(); return 1; }" >/dev/null
sleep 0.6
echo "count result: $(ev "() => document.getElementById('cd-result').textContent.replace(/\s+/g, ' ').trim()")"
echo "bankroll/rounds unchanged check: $(ev "() => document.getElementById('bankroll').textContent + ' / rounds ' + document.getElementById('stat-rounds').textContent")"
