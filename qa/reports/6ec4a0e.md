# QA round 11: 6ec4a0e (covers 3b54e0b through 6ec4a0e)

Commits: F18 counter's report card (3b54e0b), F19 seeded shoes and hand replay (ff08554), F20 KO / Hi-Opt II / Omega II counting (6ec4a0e). These were the three commits the KiroCrew loop never QA'd. First round on the new host (macOS, Node 26, Chrome via playwright-core 1.64.0), run with `node qa/run-round.js 6ec4a0e`.

## Results
- `node --test`: 326/326 pass
- engine_fuzz 0 invariant violations, basic-strategy return 99.92% over 200k rounds; spots_fuzz 100k rounds, 0 problems; strategy_diff no differences; side bets 6.11% / 4.62% exact; f12_f14_check 6/6; f15_f17_check 14/14
- f18_f20_check (engine, 17/17):
  - F19: the same seed deals identical cards for 10 shoes and another seed differs; seed text parses ("x-7" = shoe 7) and bad text is refused; replays rebuild every round exactly
  - F20: KO, Hi-Opt II and Omega II tags match the published systems; the ace side count and true-count conversion are right; balanced systems sum to 0 over a deck and KO to +4
  - F18: report math (correlation, within-a-unit, index taken/missed, luck vs skill) matches my own recomputation
- f18_f20_ui_check (browser): 11/13 in the round run. Rerun after fixing T4: see below
  - Pass: perfect counter with the count shown (gap $0, EV given away $0); flat bettor (r not measurable, flat-betting message); F19 seed entry, replay step-through, "Play this shoe again" deals the same cards; F20 panels, drill (+4 KO, 0 for balanced) and no Hi-Lo index plays under other systems
  - Fail B15 (game): perfect in-head counter is charged for correct index plays (2 of 3 runs)
  - Fail T4 (harness): the perfect-counter check required r = 1.00, but in a shoe where the count never called for a bet change the counter flat-bets and the game correctly reports "Not measurable"
- UI regression: ui_playtest 63 rounds until broke, then reset (no findings, no console errors); feature_checks 8/8; f5_f8_f9 13/13; f7_f10 7/7; f11 6/6; f12_f14_ui 6/6; focus 40/40; b14 pause; count drill 52/52 cards, count 0, 26.1 s; bet ramp comes back down

## Verified done
F19 · F20 · F18 (except B15, B16)

## New bugs
- **B15 Med**: with the count hidden, a correct index play is priced as a basic-strategy mistake. `scoreMove()` records the spot as an index play taken (`Report.countSpot` grades it with the count hidden too) but prices the move against `currentAdvice()`, which falls back to basic strategy when the count is hidden. So history, accuracy and "EV given away" all charge the player, and the shoe report shows a skill gap above $0 for a perfect counter, against report.js's own rule that following the ramp and every index gives a gap of 0. Seen: "Index plays 4 of 4" with "EV given away $0.03", history "Stood on 16 vs 10: -0.5% of your bet" at TC +1.3 (index 0); and "3 of 3" with $0.05 for 12 v 3 at TC +3.6.
- **B16 Low**: the end-of-shoe report opens from `setTimeout(settleAt + 700)` without checking that no new round has started. Dealing again quickly after the cut-card round (Rebet/Enter at default speed) opens the modal over the next hand and blocks Hit/Stand until it is closed. Seen once by ui_playtest (the report intercepted a Stand click mid-hand); ui_playtest now records this as a finding instead of stalling.

## Harness
- T2: `python3 -m http.server` reset connections on parallel script loads (7 of 30 fresh loads), so a module was missing and app.js threw at startup ("reading 'normalizeRules'" / "'houseEdge'"). Not a game bug. Fixed with qa/serve.js; 0 of 30 with it.
- T3: ui_playtest predates F18; fixed to record B16 and continue.
- T4: perfect-counter check now also accepts a flat-bet shoe that the game reports as not measurable.

## Open
B15, B16.
