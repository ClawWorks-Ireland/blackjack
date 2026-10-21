# QA round 10: fadf7e1 (covers 5c4fd5a through fadf7e1)

Commits: F15 cut-card setting + sit out on J (5c4fd5a), F16 bankroll estimates (bd71cce), F17 RSA / ENHC-OBO / restricted doubling (b5f9cc7), B14 count drill pauses when hidden (fadf7e1).

## Results
- `node --test`: 309/309 pass (includes keys.test.js: no two actions share a key)
- engine_fuzz 0 violations, basic return 99.92%; spots_fuzz 100k 0 mismatches; strategy_diff no differences; count_sim Hi-Lo 100.77%; side bets 6.11% / 4.62% exact; f12_f14_check 6/6
- f15_f17_check (new, 14/14):
  - F15: reshuffle at 50/65/75/85% lands at cut + ≤6 cards (e.g. 50%: cards 156–162 of 312); 3,000 sit-out rounds moved no money and every card shown was in the running count
  - F16: flat EV −0.358% vs house edge 0.36%; 1–12 ramp +1.77 ±0.30 units/100 at 1M rounds (other seeds +1.09 to +1.42; my count_sim +1.1 to +1.45; consistent within noise); risk of ruin falls monotonically with bankroll (50u 76% → 1600u 0.01%), flat = 100%; N0 and EV/hour formulas correct
  - F17: for 1/6/8 decks × S17/H17, RSA lowers the edge (−0.03 to −0.07), ENHC raises it (+0.11), OBO = peek game, 9–11 +0.09 to +0.16, 10–11 +0.18 to +0.30; all 2,380 chart cells in 7 variant rule sets = coach; coach never doubles where forbidden; coach costs 0 under every variant; engine refuses illegal doubles on a 10–11 table (18k hands); under ENHC a double vs dealer blackjack loses 2× bet, with OBO 1×
  - B14: countClock excludes a 60 s pause; card index comes from elapsed time
- b14_ui_check (new): faked a hidden tab at card 5 of 26 for 20 s: "Paused at card 5 of 26: come back to continue."; scored 13.4 s (not 33 s)
- UI regression: f12_f14_ui 6/6, f11 6/6, f5_f8_f9 13/13, f7_f10 7/7, feature_checks 8/8, focus 40/40, ui_playtest 80 rounds clean, count drill 52/52 cards, count 0, 26.4 s

## Verified done
F15 · F16 · F17 · B14

## Notes (not bugs, not handed off)
- N2: the sit-out phantom seat treats a split as a single hit (watchRound), so a split pair uses fewer cards than a real split would. The count stays correct; only card usage per round is slightly off.
- F16's "avg bet" is the initial bet per round (doubles and splits excluded), which is the usual definition.

## Open
Nothing. Backlog empty; no handoff published.
