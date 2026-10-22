# BlackJack QA backlog (archive)

> **Archive, closed at QA round 14 (97df14c, 22 October 2026).** Open work now lives in Linear, project BlackJack (team ClawWorks, issues CLA-93 onwards); see CLAUDE.md. Entries still open when the backlog moved are marked with their Linear issue.

Status: open · requested@<sha> = asked to be fixed (historical: sent to the KiroCrew creator) · fixed@<sha> = verified by a QA round · reopened@<sha>
Rule: a bug requested 3 rounds in a row without a fix goes to the user instead of being re-sent. Rounds where delivery was blocked don't count.

## Bugs
- B1 High   bankroll not persisted (reload = free $1000, stats disagree) — fixed@9dfcf8d
- B2 Med    money format $1002.5 / no thousands separator — fixed@9dfcf8d
- B3 Med    stranded below $1 (broke check `<= 0`, min bet 1), reproduced in browser @ab1d7d3 — fixed@9dfcf8d
- B4 High   mobile: 543px layout at 390, title clipped, header + action row don't wrap, taps < 44px (worse @ab1d7d3) — fixed@9dfcf8d
- B5 Low    deal animation spoilers (totals/prompt/actions before cards land) — fixed@9dfcf8d
- B6 Low    mid-round reshuffle; no cut card — fixed@9dfcf8d
- B7 Low    "Even money" label when player has BJ vs ace — fixed@9dfcf8d
- B8 Med    coach: soft 18 vs 2 says Double (H17 play) on an S17 table — fixed@9dfcf8d
- P1 Low    Hint button styled like disabled on phone — fixed@9dfcf8d
- D1 Low    README claims a reset button when broke (B3), S17 play (B8); omits bankroll not saved (B1) — fixed@9dfcf8d
- B9 Low    bet input max = raw bankroll (498.5) with step 1: "must be ≤ 498.5", can't bet all-in — fixed@602b73d (566e209)
- B10 Med   mobile 390x844: action buttons at y=976 during a hand (below fold); regression from count/side-bet rows — fixed@8b2d891 (re-verified @30d5a2f: actions at y=581)
- B11 Med   count bet base = last bet (app.js:682): after an 8-unit bet the 1-unit suggestion is 8 units; ramp never comes down — fixed@16098e6 (re-verified @30d5a2f)
- B12 Low   true count shown rounded (+2.0, +3.0) but the bet ramp floors it: live play @8b2d891 showed '$5 @TC +2.0' and '$10 @TC +3.0' (1 and 2 units, not 2 and 4) — fixed@1742e78 (12e0890): 16k TCs checked
- B13 Low   focus stays on BODY after a round with no decision (blackjack either side): 4/40 rounds @30d5a2f and @1742e78 — fixed@50edc73 (c2edfc2): 40/40 rounds
- N1 Low    index plays use S17 values under H17 (documented README:150) — fixed@50edc73 (1202ff1): H17 indices verified
- N2 Note   sit-out phantom seat treats split as one hit (watchRound); count correct, card usage slightly off — note only → CLA-102
- B14 Low   count drill runs on setInterval: in a hidden/background tab the timer is throttled to ~1/s (52 cards @0.5 s took 243 s live, 26.4 s visible) and the time/pace is scored as the player's. Pause the drill on visibilitychange (or refuse to score a drill that lost visibility) — fixed@fadf7e1 (fadf7e1)
- B15 Med   F18 report charges a perfect in-head counter for correct index plays. With the count hidden, scoreMove() prices the move against currentAdvice(), which falls back to basic strategy, so a correct deviation is logged as a mistake (history, accuracy, EV lost), while Report.countSpot() grades the same move as an index play taken. Observed @6ec4a0e: report "Index plays 3 of 3" yet "EV given away $0.05", skill gap +$0.05, history "#37 · mistakes: Stood on 12 vs 3: -2.0% of your bet" (TC +3.6, index +2), accuracy 96% (66 of 69); again in the round run: "4 of 4" taken, $0.03 given away for Stand 16 v 10 at TC +1.3. Expected (report.js header): following the ramp and every index exactly gives skill gap $0. Repro: count hidden, Hi-Lo, play the index on 12 v 3 at TC ≥ +2, finish the shoe. Intermittent in f18_f20_ui_check (needs an index spot with the count hidden); deterministic in code (app.js scoreMove ~753–777). — fixed@01155fe (1ca7b4f: Report.moveCorrect accepts the index play at the spot)
- B16 Low   F18 shoe report opens on setTimeout(settleAt + 700) after the cut-card round without checking that no new round has started. Dealing again within that window (Rebet/Enter at default speed) opens the modal report over the next hand and blocks Hit/Stand until closed. Seen @6ec4a0e by ui_playtest (report intercepted the #stand click mid-hand). Expected: show the report only while still between rounds (or hold the next deal until it is shown). — fixed@01155fe (1ca7b4f, 01155fe: report opens only between rounds; a held one opens as the next hand settles; qa/b16_ui_check.js)

## Harness items (my tooling, not the game)
- T1 Low    strategy_diff.js ref() doubles soft 12 (A,A unsplittable) vs 5/6; correct play is hit. Game is right (handValue A,A = soft 12). Fix the harness reference. — fixed@50edc73 (harness)
- T2 Med    UI checks served by `python3 -m http.server` hit ERR_CONNECTION_RESET on parallel script loads (7 of 30 fresh loads), so a module was missing and app.js threw at startup ("reading 'normalizeRules'/'houseEdge'"). Not a game bug. — fixed (qa/serve.js; run-round.js uses it)
- T3 Low    ui_playtest predates F18 and stalled when the shoe report covered the table (see B16). — fixed (records B16 as a finding, closes the report, continues)
- T4 Low    f18_f20_ui_check required r = 1.00 for the perfect counter, but a shoe where the count never calls for a bet change is flat-bet and correctly "Not measurable". — fixed (accepts that case when the flat-betting note shows)
- T5 Low    ui_playtest closed the shoe report and then clicked Deal, but the report's timer (settleAt + 700 ms) could fire in between and block the click for 30 s. Harness race on the same timer as B16; the game behaves as designed between rounds. — fixed (clickDeal closes the report and retries)
- T6 Low    ui_playtest only looked for a mid-hand shoe report at the top of each step, so a report opening just before an action click (B16) still timed it out. — fixed (clickInHand records B16, closes the report and retries)
- T7 High   run-round.js started its server with output ignored and waited 500 ms, so when an earlier round's server still held port 8765 the new one failed to bind and every UI check ran against that older commit. The first round on 1ca7b4f graded 37e6715's UI and reported B15 still open. — fixed (run-round waits for the server, checks it serves the commit under test, else exits 2)
- T8 Low    ui_playtest flagged B16 whenever the shoe report was open at the top of its hand loop, including just after the hand had settled, which is when the B16 fix opens a held report (seen @01155fe, round 51: result shown, actions disabled). — fixed (flags only while body.in-hand)
- T9 Low    f12_f14_ui_check read the "Mistakes cost" stat by stripping it to digits ('$0.99 (9.86% of bets)' → '$0.999.86') and testing /^\$?0(\.00)?\b/, so any cost under $1 counted as zero. Failed @8320fe7 on a $0.99 mistake; the game was right. — fixed (parses the dollar amount and checks > 0)
- T10 Low   f11_check measured Hit/Stand after one deal, but a dealer blackjack ends the round at the peek with the action row hidden: 667x375 failed @97df14c on A♠ Q♦ (1 of 9 runs). The game was right. — fixed (deals again until body.in-hand)

## Features (priority order)
- F2 basic-strategy coach (hint + mistake feedback + accuracy stat) — fixed@ab1d7d3 (built by creator on its own; B8 remains)
- F1 chip betting + rebet / rebet×2 / Enter-to-deal-again, table limits — fixed@602b73d (d5c5248)
- F3 rules settings (decks, S17/H17, 3:2 vs 6:5, DAS, surrender) + house edge; coach follows rules — fixed@602b73d (602b73d; S17→H17 recomputes house edge 0.33%→0.53%)
- F9 rules/help + payout overlay (extend the shortcuts dialog) — fixed@1742e78 (cab1669): rules, payouts, side edges, follows H17
- F4 card-counting trainer (Hi-Lo running/true count, penetration, discard tray) — fixed@9154621 (3cb690a)
- F4b bet guidance by true count (1–12 unit ramp, insurance at TC≥3; optional Illustrious 18) — fixed@9154621 (b74445e) except B11
- R1 Med   stats show win rate but not return (net ÷ wagered); win rate can't pass 50%, return is the real score — fixed@9154621 (9154621)
- F5 multiple betting spots (1–3 hands per round) — fixed@1742e78 (a1bec9b): 100k-round spots fuzz + UI verified
- F6 side bets: Perfect Pairs, 21+3 with paytables — fixed@9154621 (f59d563): edges 6.11%/4.62% verified exactly
- F7 bankroll-over-time graph, session vs lifetime stats, export history — fixed@30d5a2f (04dea5e): graph, session/all-time, CSV verified
- F8 settings: animation speed, volume slider, card back / table themes — fixed@1742e78 (713dac7): apply, persist, reduced motion verified
- F10 accessibility pass: per-card announcements, focus after round, disabled-button contrast — fixed@30d5a2f: announcements, focus after deal/round verified
- F11 installable PWA / offline, landscape phone layout — fixed@50edc73 (f60619c, 50edc73): offline + 3 landscape sizes verified
- F12 strategy chart viewer for the active rules (hard/soft/pairs grid, count-play cells marked, your own off-chart cells highlighted) — fixed@aab8554 (038d99a): engine + UI checks
- F13 training drills: basic-strategy flashcards weighted to your weak cells, and a timed count-down-a-deck drill — fixed@aab8554 (352e5d4): engine + UI checks
- F14 mistake review: each off-chart decision with its EV cost in % of the bet, from the solver in tools/ — fixed@aab8554 (aab8554): engine + UI checks
- F15 penetration setting (50–85%) and Wong out/in (sit out hands, back-count; key J) — fixed@fadf7e1 (5c4fd5a)
- F16 bankroll tools: risk of ruin and expected win per 100 hands for the current unit and ramp — fixed@fadf7e1 (bd71cce)
- F17 more rule variants: resplit aces, European no-hole-card, double on 9–11 only, with solver edges — fixed@fadf7e1 (b5f9cc7)
- F18 counter's report card per shoe/session (key E): bet correlation vs ramp, index plays taken/missed, count accuracy, skill vs luck vs a perfect counter — verified@6ec4a0e; B15/B16 fixed@01155fe (engine 17/17 incl. F19/F20; UI: perfect counter count shown r 1.00, 100% within, skill gap $0; flat bettor r not measurable)
- F19 seeded shoes + hand replay (key L): reproducible seed, step-through replay with coach/count/EV, "play this shoe again" — verified@6ec4a0e: same seed = same shoes, seed text parsing, replay step-through, play this shoe again
- F20 other count systems: KO, Hi-Opt II + ace side count, Omega II + ace side count, used by count/drills/ramp/insurance — verified@6ec4a0e: KO/Hi-Opt II/Omega II tags, ace side count, drill (+4 KO, 0 for balanced), no Hi-Lo index plays under other systems
- F21 other seats at the table (1–6 basic-strategy bots using cards) — open, later → CLA-99
- F22 translations (EN/FR/ES) — open, later → CLA-100
- F23 achievements and training streaks — open, later → CLA-101
