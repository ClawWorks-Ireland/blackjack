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
| `{"cmd":"hint"}` | `{"ok":true,"hint":{"action":"hit","reason":"Hard 12 vs dealer 10","ev":{"hit":-0.3784,"stand":-0.5398,...},"evBasis":"two-card"}}`: basic strategy as a baseline, with the EV of each legal action (see below) |
| `{"cmd":"auto","rounds":200,"policy":"basic","bet":10,"untilShuffle":false}` | `{"ok":true,"auto":{"played":200,"stopped":"rounds","net":-35,...},"obs":{...}}`: batch play, see below |
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

### Hints and EV

`hint` is basic strategy for the decision in front of you, plus `ev`: the
expected value of each legal action per unit of the hand's bet (+0.07 is 7%
of the bet won on average). Plays are priced from the solver's full-shoe
table (`engine/ev.js`), so they ignore the count; a counting agent should
expect index plays to beat them. `evBasis` says how exact the numbers are:

- `two-card`: the hand's first two cards, exact for a full shoe.
- `estimate`: a split hand, or three or more cards, priced as its total.
- `seen-cards`: the insurance offer, from the chance that the hole card is a
  ten given every card seen since the shuffle. `insurance` is the gain over
  declining per unit of the bets insured; with even money it is the sure +1
  against `decline_insurance` at the blackjack payout unless the dealer has one.

`ev` is null for a hand the table doesn't cover (a pair you can't split, played
as its total).

### Batch play

`auto` (CLI) and `auto_play` (MCP) let a built-in policy play up to 10,000
rounds in one request, so an agent spends its own moves on the rounds it
cares about: skip to the next shuffle, or play flat until the count is worth
acting on. Every round goes through the same `step`, so the table and seed
end exactly where they would if the agent had played those moves itself.

- `rounds` (required, 1 to 10,000); `policy`: `basic` (default), `hilo`,
  `never-bust` or `random` (the benchmark baselines); `bet`: a flat bet per
  spot (a number or a list), or omit it to let the policy bet (the minimum;
  `hilo` follows its count); `untilShuffle`: stop after the round that brings
  out the cut card.
- Play also stops when the bankroll can't cover the next bet. `stopped` says
  why: `rounds`, `shuffle` or `bankroll`.
- The reply has `played`, `net`, `wagered`, `bankroll` (`start`, `end`), the
  smallest and largest round's bet (`bets`), how many new shoes were shuffled
  in (`shuffles`), a tally of hand outcomes (split hands count separately),
  the best and worst round, and the table's `obs`.
  Only between rounds; a bad request is an error and changes nothing.

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
| `hint` | | basic strategy as a baseline, with the EV of each legal action |
| `auto_play` | `rounds`, `policy`, `bet`, `untilShuffle` | play many rounds with a built-in policy and report |

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

## Benchmark and leaderboard

`agent/bench.js` plays a policy over fixed seeds and scores it next to the
baselines, so an agent's result means something. Results are on
[LEADERBOARD.md](LEADERBOARD.md).

```bash
node agent/bench.js                          # every baseline, standard config
node agent/bench.js --policy hilo            # one baseline
node agent/bench.js --policy ./my-policy.js  # a JS module exporting {name, description, bet, act}
node agent/bench.js --cmd "python3 my_agent.py" --name my-agent
node agent/bench.js --policy ./my-policy.js --record   # put it on the leaderboard
```

**Standard config:** default rules, table $10–$500, a bankroll that can't run
out, seeds `bench-1` to `bench-5` × 200,000 rounds (1,000,000 in all, about
10 s for a JS policy). `--rounds N` and `--seeds a,b` make quick runs; only
standard runs can be recorded, so every leaderboard entry compares.

**Policies** see what any agent sees: `bet(obs, ctx)` returns a bet (or a list
for several spots), `act(obs, hint, ctx)` returns a name from `obs.legal`, and
`ctx` holds the seed, rules and table. Either may return a promise. The
baselines are in `policies.js`:

| Baseline | Plays |
|---|---|
| `random` | flat minimum bet, a random legal move |
| `never-bust` | flat minimum bet, hits only when it can't bust |
| `basic` | flat minimum bet, the hint every time |
| `hilo` | Hi-Lo count from `obs.shoe.seen`: 1-2-4-8-12 unit ramp, index plays, insurance at +3 |

**Any language** with `--cmd`: the bench writes one JSON object per line and
reads one back. `{"type":"bet","obs":{...}}` wants `{"bet":10}`;
`{"type":"act","obs":{...},"hint":{...}}` wants `{"action":"hit"}`.
Observations are full (rules and table included). An illegal or malformed
reply stops the run with the reason. `examples/bench-agent.js` is a
ten-line example that scores exactly like `basic`.

**Scores:** units won per 100 rounds (table-minimum units) and return (net ÷
initial bets), each ± a 95% confidence interval; average bet; chart agreement
(how often the move matched the hint); off-chart cost (EV given up against the
hint's full-shoe prices, as a share of initial bets, so a counter's index plays
count as a cost here even when they gain).
