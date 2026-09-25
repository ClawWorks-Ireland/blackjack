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

- **Betting:** type a bet or build one with $1, $5, $25, $100 and $500
  chips (Clear bet empties the box). Chips that would take you past the
  table maximum or your bankroll are disabled. After a round, Rebet
  (or Enter) deals the same bet again and Rebet ×2 (X) doubles it
- **Hint (G):** shows the basic-strategy move for these rules (dealer
  stands on soft 17) and why, for example
  "Hard 16 vs dealer ace: Surrender", and highlights the button
- **Coach notes (C to toggle):** after an off-chart move, a note says
  what the chart recommends. Moves are still scored when notes are off
- **Stats panel:** win rate (pushes excluded), wins, losses, pushes,
  blackjacks, strategy accuracy on every move, hints followed, net,
  streak, best round, and the last 20 rounds hand by hand
- **Sound (M to toggle):** card, chip and outcome sounds made with the
  Web Audio API, no audio files
- **Deal animations:** cards fly in one at a time in table order and
  the dealer's hole card flips on reveal. Totals, results and the
  action buttons appear once the last card lands. Skipped when your
  system asks for reduced motion
- **Phones:** the layout fits screens down to 360px wide, with touch
  targets at least 44px tall
- **Keyboard play:** press ? for the full list of shortcuts

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
| `sound.js` | Sounds made with the Web Audio API |
| `app.js` | UI: rendering, animations, controls and shortcuts |
| `index.html`, `style.css` | Page structure and styling |
| `*.test.js` | Tests for the five DOM-free modules |

The five DOM-free modules work in both the browser (as
`window.Blackjack`, `window.BlackjackStrategy`, `window.BlackjackStats`,
`window.BlackjackFormat` and `window.BlackjackBetting`) and Node (via `module.exports`). That's
why they can be tested without a browser.

## Not included

No card counting aids or side bets.
