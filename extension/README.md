# Casino Advisor

Real-time blackjack strategy advisor for Evolution Gaming live tables — implemented as a Manifest V3 Chrome extension.

## What it does

- **Intercepts WebSocket game events** from Evolution Gaming live blackjack tables — no frame capture, no CV, no DRM issues
- **Parses card events** using Evolution's confirmed 2-char encoding (`6D`, `JC`, `TS`, etc.)
- **Maintains running Hi-Lo count** and true count in real-time across the shoe
- **Computes basic strategy** (8-deck, S17) for the active hand
- **Recommends bet sizing** (1–5× unit) based on true count
- **Side panel HUD** — persistent, survives page reloads

## Architecture

```
manifest.json (MV3)
├── src/content/inject.js      MAIN world — overrides WebSocket constructor, intercepts game events
├── src/content/bridge.js      Isolated world — relays postMessage → chrome.runtime.sendMessage
├── src/background/
│   └── service-worker.js      Service worker — game state engine, strategy computation
├── src/shared/
│   └── card-engine.js         Card parser, Hi-Lo counter, basic strategy matrix, bet sizing
└── src/sidepanel/
    ├── sidepanel.html          Side panel HUD
    ├── sidepanel.css           Styles
    └── sidepanel.js            UI controller (listens for advice messages)
```

## Supported platforms (Phase 1)

| Platform | Method | Coverage |
|---|---|---|
| Evolution Gaming | WebSocket interception | ~40% of live blackjack market |
| Pragmatic Play Live | WebSocket interception | ~20–25% |

## Installation (development)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `packages/casino-advisor` directory

## Usage

1. Navigate to any Evolution Gaming live blackjack table (including demo play — no deposit needed)
2. Click the Casino Advisor extension icon to open the side panel
3. The side panel auto-activates when it detects a game WebSocket connection
4. During **Betting Open** phase: see bet sizing recommendation based on true count
5. During **Dealing** phase: see basic strategy action for your hand

## Tests

```bash
# All tests (card engine + simulator)
npm test

# Card engine only
npm run test:engine

# Simulator only
npm run test:sim
```

**Card engine:** 43 tests covering card parsing, hand total (including soft/hard Ace logic), Hi-Lo counter (including shuffle detection), basic strategy matrix (hard/soft/pairs), and bet sizing.

**Simulator:** 29 tests covering shoe construction, penetration-triggered reshuffles, blackjack payout (1.5×), double-down, split hands, dealer bust, surrender, bankroll accuracy (100-hand session), and full 6-deck shoe end-to-end run.

## Headless Simulator

The `simulator.js` CLI runs offline blackjack simulations — no browser required. Useful for strategy benchmarking, P&L projections, and regression testing the card engine.

### Quick start

```bash
# Basic strategy, 100 hands, $25 flat bet
node simulator.js --scenario scenarios/sample.json

# Always-stand baseline
node simulator.js --scenario scenarios/basic-stand.json --verbose

# JSON output for scripting
node simulator.js --scenario scenarios/basic-strategy.json --json

# Override any scenario parameter via CLI
node simulator.js --scenario scenarios/sample.json --decks 8 --penetration 0.80 --bankroll 2000 --bet 50 --hands 200
```

### Scenario file format

Scenario files live in `scenarios/`. Available scenarios:

| File | Strategy | Hands | Notes |
|---|---|---|---|
| `sample.json` | basic | 100 | Standard starting point |
| `basic-strategy.json` | basic | 200 | Optimal play, H17/S17 |
| `basic-stand.json` | always-stand | 100 | Baseline — never hits |

Scenario schema:

```json
{
  "description": "Human-readable label",
  "strategy": "basic | always-stand | always-hit | custom",
  "decks": 6,
  "penetration": 0.75,
  "startingBankroll": 1000,
  "bet": 25,
  "maxHands": 100,
  "minBet": 10,
  "maxBet": 500
}
```

For `strategy: "custom"`, add a `decisions` array:

```json
{
  "strategy": "custom",
  "decisions": [
    { "hand": 1, "actions": ["hit", "stand"] },
    { "hand": 2, "actions": ["double"] }
  ]
}
```

### CLI options

| Flag | Description | Default |
|---|---|---|
| `--scenario` | Path to scenario JSON (required) | — |
| `--decks` | Decks in shoe | from scenario or 6 |
| `--penetration` | Shuffle fraction (0–1) | from scenario or 0.75 |
| `--bankroll` | Starting bankroll | from scenario or 1000 |
| `--bet` | Flat bet per hand | from scenario or 25 |
| `--hands` | Max hands to play | from scenario or unlimited |
| `--verbose` | Print each hand decision | off |
| `--json` | Raw JSON output | off |

### Simulator architecture

```
simulator.js              CLI entry point — arg parsing, strategy dispatch, summary output
src/sim/
├── shoe.js               6-deck shoe, configurable penetration, Fisher-Yates shuffle, Hi-Lo tracking
└── game.js               Game state machine — startHand/step/settle, BlackjackGame + SessionTracker
src/shared/
└── card-engine.js        parseCard, handTotal, HiLoCounter, basicStrategy, betSizing
scenarios/
├── sample.json           Standard starting point — basic strategy, 100 hands
├── basic-strategy.json   Optimal play benchmark
└── basic-stand.json      Never-hit baseline
tests/
├── card-engine.test.js   43 card engine unit tests
└── simulator.test.js     29 simulator unit tests
```

**Game state JSON** (emitted at every decision point — useful for training/logging):

```json
{
  "phase": "player_decision",
  "hand": 1,
  "bet": 25,
  "bankroll": 1000,
  "playerHands": [["5H", "6D"]],
  "activeHandIndex": 0,
  "dealerCards": ["3H", "??"],
  "dealerUpcard": "3H",
  "availableActions": ["hit", "stand", "double", "surrender"],
  "shoeCardsOut": 4,
  "decksRemaining": 5.9,
  "runningCount": 2,
  "trueCount": 0.3,
  "isBlackjack": false,
  "playerTotals": [{ "total": 11, "soft": false, "bust": false }],
  "outcomes": null,
  "totalPayout": null
}
```


## Known limitations / Phase 2 work

- Blackjack seat structure is inferred from Baccarat samples — validate on first live Infinite Blackjack session
- Firefox: replace `side_panel` with `sidebar_action`
- Pragmatic Play parser: same architecture, needs PP-specific event type validation
- Index updates (deviations from basic strategy at high TC): Phase 2

## Technical notes

See `team/CASINO_ADVISOR_FEASIBILITY.md` for the full feasibility research (TASK-458) and `§ Evolution WebSocket Schema Validation` (TASK-459) for the confirmed WS schema.

Key findings:
- Evolution WS URL pattern: `wss://*.egcvi.com/app/{id}/{table_id}/websocketstream2`
- Card encoding: `{rank}{suit}` — ranks `A 2 3 4 5 6 7 8 9 T J Q K`, suits `H D C S`
- Betting phase: `args.betting = "BetsOpen" | "BetsClosed"`
- Shoe penetration: `args.shoeCardsOut` (present in `tableState` + `newGame`)
- No JWT auth needed: extension observes existing WS connections, does not initiate new ones
