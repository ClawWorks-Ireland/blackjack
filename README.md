# Blackjack

One blackjack engine, three ways to play it:

- **Agents** (`agent/`): a reset/step/observe environment, a JSON-lines
  CLI and an MCP server, so programs and models can play. Seeded and reproducible; they see
  only what a seated player sees. See [agent/README.md](agent/README.md).
- **Browser** (`web/`): a single-page game with no build step and no
  dependencies, with a basic-strategy coach, card-counting trainer and
  more (below).
- **macOS** (`macos/`): a SwiftUI app that runs the same JavaScript engine
  in JavaScriptCore. See [macos/README.md](macos/README.md).

The rules live once, in `engine/`: DOM-free JavaScript that runs in the
browser, Node and JavaScriptCore. `qa/` holds the automated QA harness.

## Play it

```bash
npm run agent -- --seed s1       # agent CLI: JSON requests on stdin, replies on stdout
npm start                        # browser game on http://127.0.0.1:8080/web/ (localhost only)
macos/scripts/run-app.sh         # macOS app
```

`npm start` serves the repo root with a small Node server (`qa/serve.js`);
`web/index.html` loads the engine from `../engine/`, so serve the root,
not `web/` alone.

Served over http(s), the browser game is an installable app (PWA): your
browser offers "Install" or "Add to Home Screen", and after one visit it
works offline. Online it always loads the latest files; offline it uses the
last copy. Opening `web/index.html` straight from disk skips this.

## Test it

```bash
npm test                         # node --test: engine, web, agent and the macOS embed check (Node 18+)
macos/scripts/ci.sh              # Swift build + tests + Swift/Node self-play cross-check
node qa/run-round.js             # full QA round on HEAD (Chrome; cd qa && npm ci first)
```

The Node tests cover the game rules, saving and restoring, the stats, the
strategy chart, bet validation, money formatting, the agent environment and
CLI, and that the macOS app embeds the current engine. They use only Node's
built-in test runner.

## Table rules

These are the defaults. **Table rules (T)** lets you change the deck
count (1, 2, 6 or 8), whether the dealer hits or stands on soft 17,
3:2 or 6:5 blackjack, double after split, late surrender, the cut card
(50% to 85%), doubling on any two cards or on hard 9-11 or 10-11 only,
resplitting aces, and European no hole card (ENHC), optionally with
original bets only (OBO). It shows
the house edge for your choice, and the coach switches to the matching
basic strategy. Rules change between hands only, with a fresh shoe;
your bankroll and stats carry over. The choice is saved.

- 6-deck shoe with a cut card three quarters of the way in. Once it
  comes out, the round finishes from the same shoe and a new one is
  shuffled before the next deal, never mid-round
- Dealer stands on all 17s, including soft 17
- Blackjack pays 3:2
- Double down on any first two cards, including after a split
- Split same-rank pairs, up to 4 hands. Split aces get one card each,
  and a 21 on a split hand pays 1:1, not 3:2
- Insurance is offered when the dealer shows an ace. It costs half your
  bet and pays 2:1 if the dealer has blackjack. If you hold blackjack
  it's called even money: taking it pays 1:1 whatever the dealer has
- Late surrender on your first two cards (not after a split) returns
  half your bet
- The dealer checks for blackjack before you play. If every one of your
  hands busts or is surrendered, the dealer doesn't draw
- With ENHC nobody checks: you play your hand first, and a dealer
  blackjack then takes everything you put out, doubles and splits
  included, and the whole bet on a surrendered hand. With OBO it takes
  only your original bet, which plays exactly like the peek game.
  Insurance is still offered and settles at the end. (The second dealer
  card is still dealt face down up front; it is only looked at after
  you play, which is the same game)
- With resplit aces, a split ace that draws another ace can be split
  again (up to 4 hands); split aces still get one card each

You start with $1,000. Table limits are $1 to $500 per hand, in whole
dollars. When you have less than the minimum left between rounds, a
button starts you over with $1,000.

## Features

- **Betting spots:** play 1, 2 or 3 spots a round, each with the bet in
  the box. Every spot is dealt and played in turn against one dealer
  hand, and each can split (up to 4 hands per spot), double or
  surrender. Insurance covers all spots; even money is offered only
  with one spot. Side bets ride on the first spot
- **Betting:** type a bet or build one with $1, $5, $25, $100 and $500
  chips (Clear bet empties the box). Chips that would take you past the
  table maximum or your bankroll are disabled. After a round, Rebet
  (or Enter) deals the same bet again and Rebet ×2 (X) doubles it
- **Hint (G):** shows the basic-strategy move for the table's current
  rules and why, for example
  "Hard 16 vs dealer ace: Surrender", and highlights the button
- **Side bets:** optional Perfect Pairs and 21+3, up to $100 each,
  settled as soon as the cards are dealt. Perfect Pairs pays 25:1 for a
  perfect pair, 12:1 colored and 6:1 mixed. 21+3 (your two cards and the
  dealer's up card) pays 100:1 suited trips, 40:1 straight flush, 30:1
  trips, 10:1 straight and 5:1 flush. The table shows each bet's exact
  house edge for the current deck count (6.11% and 4.62% at 6 decks).
  Results appear in the message and the hand history
- **Penetration and sitting out:** Table rules sets the cut card from
  50% to 85% of the shoe (default 75%); the count panel shows how much
  has been dealt. Sit out (J) deals rounds to an empty seat played by
  basic strategy: you watch and count, no money moves, and nothing goes
  into stats. With the count shown, the panel suggests sitting out below
  a true count of -1 and sitting back in at +1 (both set in Settings).
- **Bankroll (U):** enter a bankroll, betting unit and hands per hour,
  pick the 1-2-4-8-12 count ramp or flat betting, and adjust the rules
  and cut card. A seeded simulation of the real engine (1,000,000
  rounds in a Web Worker, a few seconds) gives EV and SD per 100
  rounds in units and dollars, EV per hour, N0 and risk of ruin. Under
  6 decks S17 DAS LS with 75% penetration the ramp shows about +1.2 to
  +1.4 units per 100 rounds; flat betting loses about the house edge
  and its risk of ruin is 100%. They are estimates, shown with their
  standard error.
- **Counter's report card (E):** when the cut card comes out, a shoe
  report grades you against a perfect Hi-Lo counter playing the same
  rounds: how your bets correlate with the 1-2-4-8-12 ramp on your unit
  (Pearson r, and the share within one unit), index plays taken and
  missed (hand, upcard, true count, index), your count checks and your
  running count at the cut card, and money: your result, what your bets
  and play were expected to make (luck is the difference), what the
  perfect counter expected (the skill gap), and EV given away. E shows
  the same report for the whole session. It works with the count hidden;
  the last 20 shoe reports are saved and added to the CSV export. Turn
  the automatic report off in Settings.
- **Seeded shoes and hand replay (L):** every table is seeded, and the
  current shoe's seed ("lucky-3" = shoe 3 of "lucky") shows under the
  rules line with a Copy button. Type a seed in Table rules to get the
  same shoes card for card (same rules, cut card and number of spots);
  leave it blank for a random one. The shoe report's "Play this shoe
  again" restarts the reported shoe from its first card. Replay (L) steps
  through any of the last 20 rounds card by card (← →), rebuilt by the
  engine from the logged cards and decisions, with the coach's move, the
  count a counter could see at that moment and the cost of any mistake.
- **Count systems (Settings):** Hi-Lo (default), KO (unbalanced: a
  deck sums to +4, the running count starts at 4 - 4 x decks and is read
  against a key count and a +4 pivot), Hi-Opt II and Omega II (level 2,
  with an ace side count used for betting only). The running count,
  count checks, the count drill, the bet ramp, sit-out advice, insurance
  and the report card all follow the chosen system; Rules & help shows
  every system's tags. Level-2 true counts are halved for the 1-2-4-8-12
  ramp, and each system's insurance point was measured by simulation.
  Index plays are Hi-Lo's, so the coach only uses them with Hi-Lo, and
  the bankroll simulation counts Hi-Lo.
- **Card-counting trainer (Hi-Lo):** press K to show or hide the
  running count, true count and decks unseen. The dealer's hole card
  isn't counted until it's turned over, and the count restarts with each
  new shoe. To practise, keep the count hidden, then press Q, type your
  running count (like +3) and press Enter to check it. Checks are scored
  in the stats panel. While the count is shown, the coach plays the count: the
  Illustrious 18 and Fab 4 index plays for Hi-Lo (for example stand on 12
  vs 3 at a true count of +2), insurance at +3 or more, and a suggested bet
  under the bet box: 1 unit below a true count of
  +2, then 2, 4, 8 and 12 units at +2, +3, +4 and +5 or more, capped at
  the table maximum and your bankroll. Your unit is fixed: it defaults to
  the table minimum and you can set it in the Unit box (saved). B puts
  the suggestion in the bet box. With a
  dealer ace at +3 or more, the insurance prompt says "Count says take
  it". Hints,
  accuracy and coach notes follow it
- **Coach notes (C to toggle):** after an off-chart move, a note says
  what the chart recommends. Moves are still scored when notes are off
- **Stats panel:** win rate (pushes excluded), return (money back per
  $1 bet, counting doubles, splits, insurance and side bets), wins, losses, pushes,
  blackjacks, strategy accuracy on every move, hints followed, net,
  streak, best round, and the last 20 rounds hand by hand. Switch
  between This session and All time, see a graph of your bankroll over
  the last 100 rounds, and export up to 500 rounds as CSV
- **Sound (M to toggle):** card, chip and outcome sounds made with the
  Web Audio API, no audio files
- **Settings (O):** animation speed (automatic, normal, fast or off;
  automatic turns it off when your system asks for reduced motion), a
  volume slider, and table colour and card-back themes. Saved in the
  browser
- **Deal animations:** cards fly in one at a time in table order and
  the dealer's hole card flips on reveal. Totals, results and the
  action buttons appear once the last card lands. Skipped when your
  system asks for reduced motion
- **Phones:** the layout fits screens down to 360px wide, with touch
  targets at least 44px tall. The header buttons scroll sideways in one
  row, the rules line and side-bet pay text move to Rules & help, Rebet
  and the bet box sit right under the bankroll between hands, and with
  2-3 spots the hands sit side by side with overlapping cards. Held
  sideways (landscape, under 500px tall), the table sits on the left and
  the controls on the right so the cards and actions share one screen
- **Mistake review:** after a round, each off-chart play is listed with
  what it cost in expected value, e.g. "Stood on 16 vs 10: -2.8% of your
  bet" (from the solver's EV table for the current rules). The stats
  panel shows the total as "Mistakes cost" in dollars and as a share of
  money bet, so you can tell how much of a loss was mistakes and how
  much was luck. Mistakes also appear in the history and CSV
- **Training drills (W):** practice that never touches your bankroll
  or stats. Strategy flashcards show a hand and a dealer card; answer
  with H, S, D, P or R and get the reason straight away. Cards lean
  toward the cells you miss and the tricky ones (soft doubles, splits,
  12-16), and can include a true count to drill index plays. Streak,
  accuracy and cards a minute are shown. The count drill deals a deck,
  half deck or 10 cards face up at 1.0, 0.5 or 0.3 s a card, then asks
  for the running count and your pace per deck (target: under 25 s)
- **Strategy chart (V):** the basic-strategy chart for the table's
  current rules, built from the coach so they always agree: hard totals,
  soft totals and pairs against every dealer card, colour-coded with a
  legend. With the count shown, cells with a count play are marked and
  show their index. Cells where you've made off-chart moves are
  outlined with a count, and your most missed cells are listed
- **Rules, payouts and shortcuts (?):** the table's current rules and
  house edge, every main-game payout, and the side-bet pay tables with
  their edges, plus the full list of shortcuts. Table rules links to it
- **Accessibility:** each card is read out by screen readers as it lands
  ("You: 8 of spades. Dealer: a face-down card."). After a deal, focus
  moves to the first action you can take; after a round, to Rebet or
  Deal. Disabled buttons use a dashed outline and at least 3:1 contrast
  rather than fading out

Your bankroll, the shoe and any hand in progress are saved in the
browser's `localStorage`, so a reload carries on where you left off. So
are stats, history, and the sound and coach settings. All keys start
with `blackjack.`. "Reset stats and history" in the panel clears stats
and history; it doesn't touch the bankroll.

## Keyboard shortcuts

| Key | Action |
|---|---|
| H | Hit |
| S | Stand |
| D | Double down |
| P | Split |
| R | Surrender |
| G | Basic-strategy hint |
| I / N | Take / decline insurance (or even money) |
| M | Sound on/off |
| C | Coach notes on/off |
| T | Table rules |
| K | Show or hide the count |
| Q | Check your running count |
| ? | Show shortcuts |
| Enter | Deal, or deal again with the same bet |
| X | Rebet ×2 after a round |
| B | Put the suggested bet in the bet box |
| J | Sit out / sit back in |
| U | Bankroll and risk of ruin |
| E | Counter's report card |
| L | Replay one of the last 20 hands |
| W | Training drills |
| O | Settings |
| V | Strategy chart |

## Project layout

| Folder | What it holds |
|---|---|
| `engine/` | The rules and everything computed from them. No DOM code; runs in the browser, Node and JavaScriptCore |
| `agent/` | `env.js` (reset/step/observe), `cli.js` (JSON lines), `mcp.js` (MCP server), `bench.js` + `policies.js` (benchmark, [leaderboard](agent/LEADERBOARD.md)), examples |
| `web/` | The browser UI on top of the engine |
| `macos/` | SwiftUI app; `BlackjackCore` runs `agent/env.js` and the engine it needs in JavaScriptCore |
| `qa/` | QA harness: fuzzers, rule checks, Playwright UI checks, per-round reports and the backlog archive (open work is in Linear, project BlackJack) |

| File | What it does |
|---|---|
| `engine/blackjack.js` | Game rules and the `Game` state machine. No DOM code |
| `engine/strategy.js` | Basic-strategy chart for these table rules. No DOM code |
| `engine/stats.js` | Stats, history and saved-data parsing. No DOM code |
| `engine/format.js` | Money formatting ($1,002.50). No DOM code |
| `engine/betting.js` | Bet checks, chips and rebet amounts. No DOM code |
| `engine/rules.js` | Rule options, saved-settings checks, house edge. No DOM code |
| `engine/counting.js` | Hi-Lo count, index plays and bet ramp. No DOM code |
| `web/prefs.js` | Display and sound settings, animation timing. No DOM code |
| `engine/ev.js`, `engine/ev-data.js` | Mistake cost from a precomputed EV table (`engine/tools/make_ev.js`). No DOM code |
| `engine/drill.js` | Flashcard picking and scoring, count drill decks. No DOM code |
| `engine/chart.js` | The strategy chart for any rules, built from the coach. No DOM code |
| `web/a11y.js` | Card announcements and contrast checks. No DOM code |
| `engine/report.js` | Counter's report card: bet correlation, index plays, luck vs skill. No DOM code |
| `engine/replay.js` | Rebuilds a logged round step by step for replay. No DOM code |
| `engine/bankroll.js` | Seeded bankroll simulation: EV, SD, N0, risk of ruin. No DOM code |
| `web/sim-worker.js` | Runs the bankroll simulation off the main thread |
| `engine/sidebets.js` | Perfect Pairs and 21+3 hands, payouts and exact house edge. No DOM code |
| `web/sound.js` | Sounds made with the Web Audio API |
| `web/app.js` | UI: rendering, animations, controls and shortcuts |
| `web/index.html`, `web/style.css` | Page structure and styling |
| `web/manifest.webmanifest`, `web/sw.js`, `web/icons/` | Install and offline support |
| `*.test.js` | Tests next to the code they cover (`engine/`, `web/`, `agent/`) |
| `engine/tools/` | The solver behind the strategy chart and house edge (not loaded by the game) |

The DOM-free modules work in both the browser (as
`window.Blackjack`, `window.BlackjackStrategy`, `window.BlackjackStats`,
`window.BlackjackFormat`, `window.BlackjackBetting`, `window.BlackjackRules`,
`window.BlackjackCounting`, `window.BlackjackSideBets`, `window.BlackjackA11y`, `window.BlackjackPrefs`, `window.BlackjackBankroll` and the rest) and Node (via `module.exports`). That's
why they can be tested without a browser.

## Not included

The index plays are the standard shoe-game values, with the H17 set (11 vs A, 10 vs A, 15 vs A) when the dealer hits soft 17. They aren't adjusted for 1 or 2 decks.

## How the strategy chart was made

`engine/tools/solver.js` computes the expected value of every play for every
starting hand, removing cards from the shoe as they're dealt and
handling the dealer's unseen hole card exactly. A chart cell is the best
play averaged over every two-card hand with that total. For 4 to 8 decks
this reproduces Wizard of Odds' published S17 and H17 charts cell for
cell. `engine/tools/make_charts.js` writes `engine/tools/charts.json` for all 96 rule
combinations (decks, S17/H17, DAS, peek or ENHC, and doubling on any
two cards, 9-11 or 10-11), and `engine/strategy.test.js` checks `engine/strategy.js`
against every cell. Splits are valued without resplitting, a small
approximation. ENHC values each play as (1 - p) times its peek-game EV
minus p times the chips at risk, with p the chance of a dealer
blackjack given your cards. Resplitting aces and OBO change no cell.
`engine/tools/make_ev.js` writes the matching EV table (`engine/ev-data.js`) that
prices mistakes.

The house edge uses Wizard of Odds' published figures for these rules
without surrender, plus adjustments from `engine/tools/house_edge.js` for late
surrender, 6:5, ENHC (about +0.11 points), doubling on 9-11 (+0.09 to
+0.15) or 10-11 (+0.17 to +0.30), and resplitting aces (-0.03 to
-0.06, one extra split valued). It assumes basic strategy. It also includes the
cost of the cut card (the shoe is dealt to 75% and only shuffled
between rounds): 0.13 points at 1 deck, 0.07 at 2 decks and 0.03 at 6
or 8, measured by simulating about 60 million rounds of this game per
rule set. Without it the default table would show 0.33%; with it, 0.36%.
The cut-card figure is for 75% penetration whatever the slider says, and
the count indices (Illustrious 18, Fab 4) are the standard peek-game
ones under every rule variant.
