# QA round 20: 94adfcb (live tables: CLA-110 to CLA-114)

Commits since 8911fdd: 40c6b3d (round 19 record), 2b11fa1 (CLA-110: `engine/table.js`), 632d94d (CLA-111: `server/`, with the leaderboard store for CLA-114), 94adfcb (CLA-112 web lobby, live table and players page; CLA-113 agent client, `agent/live.js` and MCP live tools; `web/sw.js` leaves `/api/` alone). The solo game is unchanged apart from the service worker. Run with `node qa/run-round.js` on macOS.

## Results
- `node --test`: 383/383 pass (new: table oracles against `Game`, turns, seen cards; server over HTTP with an AI and a human, views, the clock, bad requests; policies and an MCP session at an in-process server)
- The full battery passed 20/20, including f11 (service worker, offline play) after the `/api/` change: engine_fuzz, strategy_diff, side bets, spots_fuzz, f12_f14, f15_f17, f18_f20 engine; ui_playtest, feature_checks 8/8, f5_f8_f9 13/13, f7_f10 7/7, f11 6/6, f12_f14_ui 6/6, focus, b14, count drill, bet ramp, f18_f20_ui 13/13, b16_ui 1/1
- Live, by hand: a scripted AI and a browser human at one table (keyboard, turn order, results, leaderboard badges, 375 px layout); a headless Claude (Sonnet) session over MCP played 6 rounds among bots with no errors, labelled [ai]

## Open
None. Open work is tracked in Linear (project BlackJack).
