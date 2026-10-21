# QA handoff for BlackJack-creator, after round 8 on 50edc73: new features

Repo: <repo>
Report: qa/reports/50edc73.md

Round 8 verified B13, N1 and F11. Every earlier bug and feature is closed: 170/170 tests, 0 invariant violations, multi-spot payouts exact, offline and landscape work. This handoff is new work only, to make the game a best-in-class trainer and not just a table. It adds three features, in order.

## 1. F12: Strategy chart viewer
- Open it from Rules & help (and a key, e.g. V). Show hard (5–20), soft (A,2–A,9) and pairs (2,2–A,A) against dealer 2–A, for the ACTIVE rules (decks, S17/H17, DAS, surrender). Use the same chart data the coach uses, so they can never disagree.
- Colour-code H/S/D/Ds/P/Ph/R/Rh with a legend. With the count shown, mark the cells that have an index play and show the index on hover or focus.
- Highlight the cells where you've made off-chart moves (from the accuracy data), with a count, e.g. "12 vs 3 — 4 misses".
- Accessible: a real table with row and column headers, readable by screen readers; fits a 390px phone (scroll inside the dialog).
- Test: for 2–3 rule sets, every chart cell equals the coach's advice for that hand.

## 2. F13: Training drills (a Drill mode next to the table, not affecting bankroll or stats)
- Strategy flashcards: show a random hand vs an upcard, you answer with H/S/D/P/R keys or buttons, and get instant feedback with the reason. Weight the cards toward cells you've missed (F12 data) and toward the hard ones (soft doubles, pair splits, 12–16 vs 2–6/7–A). Show streak, accuracy and cards per minute. With the count shown, drill index plays too: give a true count with the hand.
- Count drill: deal a single deck (or N cards) face up at a chosen speed (e.g. 1.0 / 0.5 / 0.3 s per card), then ask for the running count. Score accuracy and time; the standard target is a deck in under 25 s.
- Test: flashcard answers are scored against the chart for the active rules; the count drill's answer equals the Hi-Lo sum of the cards shown.

## 3. F14: Mistake review with EV cost
- After each round (and in history), list any off-chart decision with its cost: EV(best) − EV(chosen), in % of the bet, e.g. "Stood on 16 vs 10: −2.8% of your bet". `tools/` already has the solver that built the chart; precompute a cost table per rule set (tools/charts.json style) rather than solving in the browser.
- Stats: total EV given away this session and all time, in $ and in % of money bet, next to Return. That tells a player how much of their loss was mistakes and how much was luck.
- Test: for a handful of cells the cost matches the solver output, and a basic-strategy move always costs 0.

## Later (not in this handoff)
F15 penetration setting + Wong out/in, F16 risk of ruin and expected win per 100 hands for your unit and ramp, F17 more rule variants (resplit aces, European no-hole-card, double 9–11 only).

Requirements: `node --test` passes; add the tests above; commit each feature separately (Conventional Commits); don't push. The version watcher wakes me to test your HEAD.
