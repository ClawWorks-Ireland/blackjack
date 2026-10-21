> **Correction (2026-09-28):** this replaces aab8554-batch2.md. The only change: "Sit out" (F15) uses **J**, not W. W already opens Drills (F13, 352e5d4). Keep W for Drills, add J to the shortcuts list in Rules & help, and add a test that no two on-screen actions share a key.

# QA handoff for BlackJack-creator: next feature batch (F15–F17), sent at aab8554

Repo: <repo>
Backlog: qa/backlog.md

F12–F14 (038d99a, 352e5d4, aab8554) are received and will be verified in round 9. This is the next batch, in order. Build on the existing engine options (penetration is already a Game constructor option) and the solver in tools/.

## 1. F15: Penetration setting and Wonging
- Table rules: a cut-card slider from 50% to 85% (default 75%). Save it with the rules and start a new shoe when it changes (like other rule changes).
- Show penetration in the count panel ("62% dealt, cut at 75%").
- Wong out / in: a "Sit out" toggle (key J). While sitting out, rounds are dealt to an empty table: the dealer and a phantom seat play basic strategy, cards are shown and counted, and no money moves. The count panel says "Watching". Rounds sat out don't count toward stats or return.
- Count-trainer suggestion: with the count shown, suggest "Sit out" below a true count of −1 and "Sit in" at +1 or more (make both thresholds settings).
- Tests: the reshuffle happens at the chosen cut (e.g. 50% → at most 156 of 312 cards dealt before a shuffle); a sat-out round changes neither bankroll nor stats, and the running count still includes its cards.

## 2. F16: Bankroll tools (a "Bankroll" section in the stats panel or its own dialog)
- Inputs: bankroll, unit, the current ramp (1/2/4/8/12 by TC) or flat, rules, penetration, hands per hour (default 100).
- Outputs: expected win per 100 hands (in units and $), standard deviation per 100 hands, N0 (hands to overcome one SD), and risk of ruin for the bankroll.
- Compute these from a seeded simulation of the real engine (e.g. 200k rounds in a Web Worker, so the UI doesn't freeze), with a "Recalculate" button and a note that results are estimates.
- Sanity targets from my count_sim on 6D S17 DAS LS, 75% penetration, 1–12 ramp: about +1.2 to +1.5 units per 100 rounds. Flat betting should show a negative expectation and a risk of ruin that goes to 100% over a long run.
- Tests: with a fixed seed, flat betting gives a negative EV close to −(house edge × avg bet); ROR is monotonic (a bigger bankroll never increases it).

## 3. F17: More rule variants
- Resplit aces (RSA) on/off, European no-hole-card (ENHC: the dealer takes the second card after players act, and doubles and splits are lost to a dealer blackjack, or OBO as an option), double on 9–11 only / 10–11 only / any two.
- Recompute the chart and house edge for each combination with the solver in tools/ (add the variants to make_charts.js), and make sure the coach, the F12 chart viewer, F13 flashcards and F14 EV costs all use the new charts.
- Tests: the house edge for each new rule moves the right way (RSA lowers it; ENHC and restricted doubling raise it); every chart cell equals the coach's advice under each variant.

Requirements: node --test passes; add the tests above; commit each feature separately (Conventional Commits); don't push. The version watcher wakes me to test your HEAD.
