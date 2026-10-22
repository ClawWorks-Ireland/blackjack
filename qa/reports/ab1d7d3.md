# QA round 2 — BlackJack ab1d7d3 (coach, hints, shortcuts help)

Tester: BlackJack-player · 2026-09-25 · snapshot of commit ab1d7d3, covering 526e9d9..ab1d7d3 (6 commits)

## Summary
The new features work: Hint, coach notes, accuracy and hints-followed stats, the C toggle, and the `?` help dialog (Esc closes it, and it lists every on-screen shortcut). 52/52 tests pass and there are no console errors. The engine is still clean (0 violations in 240k rounds, basic-strategy return 99.83%).

None of the 7 round-1 bugs is fixed yet. That report never reached you, so all of it is below. The phone layout got worse, and there's one new coach bug.

## New in this round
| id | sev | finding | evidence | expected |
|---|---|---|---|---|
| B8 | Medium | The coach recommends Double on soft 18 (A,7) against a dealer 2. That's the H17 play. This table is S17, where the chart says Stand, so correct play is scored as a mistake and accuracy drops. | `qa/strategy_diff.js`: every 2-card hand × upcard vs an independent 6D S17 DAS LS chart. This is the only difference. `strategy.js` softMove: `if (inRange(up, 2, 6)) return 'double-or-stand'` | Soft 18: double vs 3–6 (stand if you can't double), stand vs 2, 7 and 8, hit vs 9, 10 and A. Add a unit test for A,7 vs 2. When F3 (rules settings) lands, H17 switches it back to double. |
| B4 ↑ | Medium→High | The phone layout is worse. At 390px the page now lays out 543px wide, so the "Blackjack" title is clipped on the left ("ackjack"). The three header toggles squash ("Sound on" breaks over 3 lines), and the action row, now with Hint, runs off the edge. | `qa/reports/ab1d7d3/07-mobile-in-round.png` | Wrap the header and the action row (Hint can sit on its own line). No horizontal zoom at 360 and 390px, and touch targets at least 44px. |
| B3 ✔ repro | Medium | Stranded below $1, now seen in the browser: at $0.50 you can't deal and no reset appears. | `qa/reports/ab1d7d3/f4-stranded.png`. Message: "You surrendered. $0.5 is returned." | Same as round 1: below the minimum bet counts as broke, and the reset is offered. |
| P1 | Low | On a phone, Hint is dark while the other actions are gold, so it looks disabled when it isn't. | `07-mobile-in-round.png` | Make the enabled/disabled states consistent with the other action buttons. |

## Still open from round 1 (details in `qa/reports/526e9d9.md`)
- B1 High: the bankroll isn't saved, but stats are. A reload refills $1000 while stats keep Net −$999.50.
- B2 Medium: money shows as `$832.5` or "win $37.5", with no thousands separator. Seen in 42 of 80 rounds.
- B5 Low: during the deal animation, totals, "Your move." and live actions appear before the cards land.
- B6 Low: the shoe reshuffles mid-round with no cut card (4,157 of 200k simulated rounds).
- B7 Low: holding blackjack against a dealer ace should read "Even money", not insurance.

## Features this round
- F2 (strategy coach) is **done**: verified in the browser, apart from B8.
- Next up: F1 chip betting (chips, Clear, Rebet, Rebet×2, Enter/Space to deal again, table min/max) and F3 rules settings (decks, S17/H17, 3:2 or 6:5, DAS, surrender, with house edge; the coach must follow them). Also F9, a payout/rules help panel, which extends the new shortcuts dialog.

## Screenshots
`qa/reports/ab1d7d3/`: f1-hint, f2-coach-note, f3-help, f4-stranded, 07-mobile-in-round, and others.
