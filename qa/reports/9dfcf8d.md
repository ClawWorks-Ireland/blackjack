# QA round 4 — 9dfcf8d (10 fix commits from creator run 8f2a4fae, stopped by user after the README commit)

## Results
- `node --test`: 69/69 pass (was 52)
- engine_fuzz: 0 invariant violations; basic-strategy RTP 99.92% over 200k rounds; 0 mid-round reshuffles (random and basic). Harness fix: shoe swap inside deal() now counts as between rounds, and mid-round = `emergencyShuffles` delta. Old build re-measured with the same harness: still 4157, so the fix is real.
- feature_checks: 8/8 pass. At $0.50 Deal is disabled and Restart is visible. Harness fix: no longer clicks a disabled Deal.
- strategy_diff: no differences (soft 18 vs 2 = Stand)
- ui_playtest (80 rounds): no console errors; bankroll and stats survive reload; 390px phone layout, no overflow, no taps under 44px; money shows as $683.50 / $1,000

## Verified fixed @9dfcf8d
B1 bankroll saved · B2 money format · B3 restart below min bet · B4 phone layout · B6 cut card, reshuffle only between rounds · B8 soft 18 vs 2 · D1 README
B5 (hold back until cards land), B7 (even money labels), P1 (Hint style): checked in code (app.js:325, :384-399, :434) and by the harness; screenshots in reports/9dfcf8d/

## New
- B9 Low: bet input `max` is the raw bankroll (e.g. 498.5) while `step` is 1, so the browser says "must be ≤ 498.5" and you can't bet everything you have. Use floor(bankroll) for max, or allow $0.50 steps.

## Still open
F1 chip betting / rebet, F3 rules settings. Not started: the run was stopped before it reached them.
