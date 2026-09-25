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

The tests cover the game rules, the stats, and the strategy chart. They
use only Node's built-in test runner.

## Table rules

- 6-deck shoe, reshuffled when fewer than 52 cards remain
- Dealer stands on all 17s, including soft 17
- Blackjack pays 3:2
- Double down on any first two cards, including after a split
- Split same-rank pairs, up to 4 hands. Split aces get one card each,
  and a 21 on a split hand pays 1:1, not 3:2
- Insurance is offered when the dealer shows an ace. It costs half your
  bet and pays 2:1 if the dealer has blackjack
- Late surrender on your first two cards (not after a split) returns
  half your bet
- The dealer checks for blackjack before you play. If every one of your
  hands busts or is surrendered, the dealer doesn't draw

You start with $1000. If you run out, a button resets the bankroll.

## Features

- **Hint (G):** shows the basic-strategy move and why, for example
  "Hard 16 vs dealer ace: Surrender", and highlights the button
- **Coach notes (C to toggle):** after an off-chart move, a note says
  what the chart recommends. Moves are still scored when notes are off
- **Stats panel:** win rate (pushes excluded), wins, losses, pushes,
  blackjacks, strategy accuracy on every move, hints followed, net,
  streak, best round, and the last 20 rounds hand by hand
- **Sound (M to toggle):** card, chip and outcome sounds made with the
  Web Audio API, no audio files
- **Deal animations:** cards fly in one at a time in table order and
  the dealer's hole card flips on reveal. Skipped when your system asks
  for reduced motion
- **Keyboard play:** press ? for the full list of shortcuts

Stats, history, and the sound and coach settings are saved in the
browser's `localStorage` under keys starting with `blackjack.`. Use
"Reset stats and history" in the panel to clear them.

## Keyboard shortcuts

| Key | Action |
|---|---|
| H | Hit |
| S | Stand |
| D | Double down |
| P | Split |
| R | Surrender |
| G | Basic-strategy hint |
| I / N | Take / decline insurance |
| M | Sound on/off |
| C | Coach notes on/off |
| ? | Show shortcuts |
| Enter | Deal (in the bet box) |

## Project layout

| File | What it does |
|---|---|
| `blackjack.js` | Game rules and the `Game` state machine. No DOM code |
| `strategy.js` | Basic-strategy chart for these table rules. No DOM code |
| `stats.js` | Stats, history and saved-data parsing. No DOM code |
| `sound.js` | Sounds made with the Web Audio API |
| `app.js` | UI: rendering, animations, controls and shortcuts |
| `index.html`, `style.css` | Page structure and styling |
| `*.test.js` | Tests for the three rule modules |

The three rule modules work in both the browser (as `window.Blackjack`,
`window.BlackjackStrategy` and `window.BlackjackStats`) and Node (via
`module.exports`). That's why they can be tested without a browser.

## Not included

No card counting aids or side bets. The layout is built for desktop
screens and hasn't been tuned for phones.
