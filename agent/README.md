# Agent interface

Play blackjack from a program. The environment wraps the same engine the web
and macOS apps use (`engine/`), so an agent plays exactly the game a person
does: same rules, same shoe for the same seed.

- **Deterministic.** Every table is seeded. Without `--seed` a random seed is
  chosen and reported in `obs.shoe.seed`; replaying that seed with the same
  actions reproduces the session exactly.
- **Fair.** Observations show only what a seated player can see: the
  dealer's hole card stays hidden until the round ends, and the shoe order is
  never exposed. `obs.shoe.seen` counts every card revealed since the last
  shuffle, so a counting agent need not track cards itself.
- **Strict.** Illegal actions, unknown rules and bad bets are errors with a
  reason, never silent fallbacks. Nothing changes on an error.

## JSON-lines CLI

```bash
node agent/cli.js --seed s1 --rules '{"h17":true,"payout":1.2}'
```

Options: `--seed S` (`"s1-5"` starts at shoe 5), `--rules JSON`, `--bankroll N`
(default 1000), `--min-bet N` (1), `--max-bet N` (500).

Send one JSON object per line on stdin; one JSON object comes back per line
on stdout. The first line out is `{"ok":true,"event":"ready","obs":{...}}`.
Any `"id"` you send is echoed back.

| Request | Reply |
|---|---|
| `{"action":"deal","bet":10}` | `{"ok":true,"obs":{...},"reward":0,"done":false}` |
| `{"action":"deal","bet":[10,10],"side":{"pairs":5,"t213":5}}` | two spots, side bets ride on the first |
| `{"action":"hit"}` / `stand` / `double` / `split` / `surrender` | as above |
| `{"action":"insurance"}` / `{"action":"decline_insurance"}` | when `obs.phase` is `insurance` |
| `{"cmd":"observe"}` | `{"ok":true,"obs":{...}}` (full, including rules and table) |
| `{"cmd":"legal"}` | `{"ok":true,"legal":["hit","stand",...]}` |
| `{"cmd":"hint"}` | `{"ok":true,"hint":{"action":"stand","reason":"Hard 16 vs dealer 10"}}`: basic strategy, as a baseline |
| `{"cmd":"reset","seed":"s2","rules":{...},"bankroll":500}` | new table, full `obs` |
| `{"cmd":"quit"}` | `{"ok":true,"event":"bye"}`, then the process exits |
| anything invalid | `{"ok":false,"error":"...","legal":[...]}` |

`reward` is the round's total chip change (main bets, insurance and side bets)
on the step that ends the round (`done: true`), and 0 otherwise. A round can
end on the deal itself (a natural, or a dealer blackjack found by the peek).

### Rules

`decks` (1, 2, 6, 8), `h17` (dealer hits soft 17), `payout` (1.5 or 1.2),
`das` (double after split), `lateSurrender`, `rsa` (resplit aces), `enhc`
(European no hole card), `obo` (ENHC original bets only; needs `enhc`),
`doubleOn` (`"any"`, `"9-11"`, `"10-11"`), `penetration` (0.5 to 0.85 in 0.05
steps). Defaults: 6 decks, S17, 3:2, DAS, late surrender, no RSA, hole card,
double any two, 75% penetration.

### Observation

```json
{
  "phase": "player",                  // betting | insurance | player | done
  "round": 1,
  "bankroll": 975,                    // chips not on the table
  "legal": ["hit", "stand", "double", "surrender"],
  "shoe": { "seed": "demo-1", "decks": 6, "cardsLeft": 309, "cutCardReached": false,
            "seen": { "A": 0, "2": 0, "3": 0, "4": 1, "5": 1, "...": 0, "T": 0, "J": 0, "Q": 0, "K": 0 } },
  "dealer": { "cards": ["4d"], "total": 4, "holeCardHidden": true },
  "hands": [ { "cards": ["8c", "5c"], "total": 13, "soft": false, "bet": 25, "spot": 0,
               "fromSplit": false, "splitAces": false, "surrendered": false, "result": null } ],
  "active": 0,                        // index into hands while phase is player
  "insurance": { "offered": false, "evenMoney": false, "cost": 0, "stake": 0, "net": null },
  "sideBets": [],                     // e.g. { "bet": "pairs", "stake": 5, "outcome": "lose", "win": null, "odds": 0, "net": -5 }
  "net": null,                        // the round's chip change once done
  "broke": false                      // bankroll below the minimum bet
}
```

Cards are rank (`A 2-9 T J Q K`) + suit (`s h d c`). `cardsLeft` counts the
hole card while it is hidden, so `sum(seen) + cardsLeft` is always the shoe
size. Side bets settle on the deal: `win` names the winning hand (`"Mixed
pair"`, `"Flush"`, ...) and `odds` its payout, or `null` and 0 on a loss. With
a blackjack against an ace, `insurance.evenMoney` is true and `insurance`
takes even money. The dealer peeks under a 10 or an ace unless `enhc` is set.
Replies to steps leave out `rules` and `table`, which only change on
`reset`; `observe` and `reset` include them.

## MCP server

`agent/mcp.js` puts the same table behind the Model Context Protocol, so an
MCP client such as Claude Code or Claude Desktop can play it. It takes the
CLI's options and has no dependencies. Opening this repository in Claude Code
offers it through `.mcp.json`; elsewhere, add it with:

```bash
claude mcp add blackjack -- node /path/to/blackjack/agent/mcp.js --seed s1
```

| Tool | Arguments | Does |
|---|---|---|
| `new_table` | `seed`, `rules`, `bankroll`, `minBet`, `maxBet` (all optional) | sit at a new table |
| `deal` | `bet` (a number, or up to 3 for several spots), `side` | bet and deal a round |
| `act` | `action`: `hit`, `stand`, `double`, `split`, `surrender`, `insurance`, `decline_insurance` | play the active hand |
| `observe` | | the full observation, with rules and table |
| `hint` | | basic strategy, as a baseline |

Each result is a one-line summary of the table, then the same JSON the CLI
replies with. An illegal move is a tool error (`isError`) naming the legal
ones, and the table does not change. The fairness rules above hold: the hole
card shows as `+ hole card` until the round ends.

## From JavaScript

```js
const { BlackjackEnv } = require('./agent/env.js');
const env = new BlackjackEnv({ seed: 's1', rules: { h17: true } });
let { obs, reward, done } = env.step({ action: 'deal', bet: 10 });
while (!done) ({ obs, reward, done } = env.step(env.hint().action));
```

`agent/examples/basic-strategy.js` drives the CLI over a pipe, the way an
agent in another language or a local model would.
