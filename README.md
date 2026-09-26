# Blackjack

A single-page blackjack game that runs in the browser with no build step
and no dependencies. It plays standard casino rules and includes a
basic-strategy coach that hints, scores your moves, and explains mistakes.

## Run it

Open `index.html` directly in a browser, or serve it locally:

```bash
npm start            # serves on http://127.0.0.1:8080 (localhost only)
```

`npm start` uses Python's built-in web server, so it needs `python3`.

## Test it

```bash
npm test             # node --test, Node 18 or newer
```

The tests cover the game rules, saving and restoring, the stats, the
strategy chart, bet validation and money formatting. They use only Node's built-in test
runner.

## Table rules

These are the defaults. **Table rules (T)** lets you change the deck
count (1, 2, 6 or 8), whether the dealer hits or stands on soft 17,
3:2 or 6:5 blackjack, double after split, and late surrender. It shows
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
  targets at least 44px tall
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

## Project layout

| File | What it does |
|---|---|
| `blackjack.js` | Game rules and the `Game` state machine. No DOM code |
| `strategy.js` | Basic-strategy chart for these table rules. No DOM code |
| `stats.js` | Stats, history and saved-data parsing. No DOM code |
| `format.js` | Money formatting ($1,002.50). No DOM code |
| `betting.js` | Bet checks, chips and rebet amounts. No DOM code |
| `rules.js` | Rule options, saved-settings checks, house edge. No DOM code |
| `counting.js` | Hi-Lo count, index plays and bet ramp. No DOM code |
| `prefs.js` | Display and sound settings, animation timing. No DOM code |
| `a11y.js` | Card announcements and contrast checks. No DOM code |
| `sidebets.js` | Perfect Pairs and 21+3 hands, payouts and exact house edge. No DOM code |
| `sound.js` | Sounds made with the Web Audio API |
| `app.js` | UI: rendering, animations, controls and shortcuts |
| `index.html`, `style.css` | Page structure and styling |
| `*.test.js` | Tests for the ten DOM-free modules |
| `tools/` | The solver behind the strategy chart and house edge (not loaded by the game) |

The ten DOM-free modules work in both the browser (as
`window.Blackjack`, `window.BlackjackStrategy`, `window.BlackjackStats`,
`window.BlackjackFormat`, `window.BlackjackBetting`, `window.BlackjackRules`,
`window.BlackjackCounting`, `window.BlackjackSideBets`, `window.BlackjackA11y` and `window.BlackjackPrefs`) and Node (via `module.exports`). That's
why they can be tested without a browser.

## Not included

The index plays are the standard shoe-game (S17) values and are used for every rule set.

## How the strategy chart was made

`tools/solver.js` computes the expected value of every play for every
starting hand, removing cards from the shoe as they're dealt and
handling the dealer's unseen hole card exactly. A chart cell is the best
play averaged over every two-card hand with that total. For 4 to 8 decks
this reproduces Wizard of Odds' published S17 and H17 charts cell for
cell. `tools/make_charts.js` writes `tools/charts.json` for all 16 rule
combinations, and `strategy.test.js` checks `strategy.js` against every
cell. Splits are valued without resplitting, a small approximation.

The house edge uses Wizard of Odds' published figures for these rules
without surrender, plus late-surrender and 6:5 adjustments from
`tools/house_edge.js`. It assumes basic strategy. It also includes the
cost of the cut card (the shoe is dealt to 75% and only shuffled
between rounds): 0.13 points at 1 deck, 0.07 at 2 decks and 0.03 at 6
or 8, measured by simulating about 60 million rounds of this game per
rule set. Without it the default table would show 0.33%; with it, 0.36%.
