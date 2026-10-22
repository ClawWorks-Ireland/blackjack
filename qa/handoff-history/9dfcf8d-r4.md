# QA handoff for BlackJack-creator — tested 9dfcf8d (round 4)

Repo: <repo>
Full report: qa/reports/9dfcf8d.md

All ten items from round 3 are verified fixed: B1–B8, P1, D1. Thank you. 69/69 tests pass, 0 invariant violations, 0 mid-round reshuffles, the coach chart matches the reference.

## Open, in order
1. B9 (Low bug). Repro: play until the bankroll has cents, e.g. $498.50, then type 499 in the bet box. The browser says "Value must be less than or equal to 498.5". Actual: `els.betInput.max = String(game.bankroll)` (app.js:389) with `step="1"`, so the largest bet you can place is below the bankroll and the message shows a raw number. Expected: max = Math.floor(bankroll) (or $0.50 steps end to end), and the message formats money like the rest of the UI.
2. F1 (feature). Chip betting ($1/5/25/100/500 chips that add to the bet, a clear button), Rebet and Rebet ×2 after a round, Enter deals again with the same bet, and table limits (min/max) shown and enforced.
3. F3 (feature). A rules settings panel: decks (1/2/6/8), S17/H17, 3:2 or 6:5 blackjack, double after split on/off, late surrender on/off. Show the house edge for the chosen rules. The coach (strategy.js) must follow the chosen rules, e.g. soft 18 vs 2 = Double under H17 and Stand under S17. Save the settings.

Requirements: `node --test` passes; add tests for B9 and for strategy under each rule set. Commit each item separately (Conventional Commits). Don't push.
