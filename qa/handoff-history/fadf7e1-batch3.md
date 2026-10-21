# QA handoff for BlackJack-creator: feature batch 3 (F18–F20), after round 10 on fadf7e1

Repo: <repo>
Report: qa/reports/fadf7e1.md

Round 10 verified F15, F16, F17 and B14 (309/309 tests; 2,380 variant chart cells = coach; cut card, sit out, bankroll maths and the hidden-tab pause all correct). Backlog is empty. This batch turns the trainer into something that grades a counter the way a casino session would. Three features, in order.

Keys already used: ? B C D G H I J K M N O P Q R S T U V W X. Free: A E F L Y Z. Use only the keys named below, and keep keys.test.js passing.

## 1. F18: Counter's report card (key E)
- A "shoe report" at each reshuffle, and a session report on demand (E), that grades the player against a perfect Hi-Lo counter playing the same cards:
  - Bet correlation: the player's actual bets vs the ramp's suggested bet at each round's true count (Pearson r, plus "% of rounds within one unit of the ramp").
  - Index plays: how many deviation spots came up, how many were taken correctly, and the ones missed (hand, upcard, TC, index).
  - Count accuracy: the Q count-checks for this shoe, and the running count error at the reshuffle if the player enters it.
  - Money: actual result vs what the perfect counter would have made with the same cards and unit (luck vs skill), plus EV given away from F14.
- Works with the count hidden (the point is to count in your head). Save the last 20 shoe reports; include them in the CSV export.
- Tests: a scripted shoe where the player follows the ramp and every index exactly gives r = 1, 100% of index plays taken, and a skill gap of 0; flat betting gives r = 0 or undefined, with a clear message.

## 2. F19: Seeded shoes and hand replay (key L)
- Rules → "Shoe seed": leave it blank for random, or enter a seed to get the exact same shoe (shown after every shuffle, copyable). Seeded shoes must reproduce card-for-card with the same rules, penetration and number of spots.
- Replay (L): pick any of the last 20 rounds from history and step through it card by card (← →), showing each decision, the coach's move, the count at that moment and the EV cost of any mistake.
- "Play this shoe again" restarts the same seed so a player can re-run a shoe with better play and compare report cards (F18).
- Tests: two engines with the same seed deal identical cards for 10 shoes; replaying a stored round reconstructs every hand, total and result exactly; the seed survives a reload.

## 3. F20: Other counting systems
- Settings → Count system: Hi-Lo (default), KO (unbalanced, with key count and pivot), Hi-Opt II with an ace side count, and Omega II with an ace side count. Show each card's tag in the Rules & help overlay.
- The running count, true count (KO uses the running count against its key/IRC), count checks, drills (F13 count drill), bet ramp and insurance advice all follow the chosen system. For index plays, either ship published indices per system or say plainly "index plays use Hi-Lo; switch to Hi-Lo for deviations".
- Tests: a full deck sums to 0 for the balanced systems and to +4 (single deck) for KO; the Hi-Opt II ace side count adjusts betting only (not the running count); each system's count-drill answer equals its own tag sum.

## Later (not in this batch)
F21 other seats at the table (bots playing basic strategy that use up cards, 1–6 seats), F22 translations (i18n with EN/FR/ES to start), F23 achievements and training streaks. Low note N2: the sit-out phantom seat treats a split as a single hit; fix it if you touch watchRound.

Requirements: `node --test` passes; add the tests above; commit each feature separately (Conventional Commits); don't push. The version watcher wakes me to test your HEAD.
