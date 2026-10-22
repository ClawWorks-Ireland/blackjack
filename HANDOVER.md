# BlackJack project — handover

> **Status, 21 October 2026.** This document describes the project as handed
> over from the KiroCrew host on 13 October. Since then: the game is on GitHub
> (`delmarolivier/blackjack`), the QA harness lives in `qa/` (run a round with
> `node qa/run-round.js`; see `qa/PLAYBOOK.md`), the owed round on 6ec4a0e has
> been run (`qa/reports/6ec4a0e.md`), and the code is split into `engine/`,
> `web/`, `agent/` and `macos/` (see README.md). The KiroCrew crons and paths
> below are historical; none were set up on the new host.

Everything a new agent/engineer needs to pick up this project cold. Written 2026-10-13.

## 1. What this is

A browser Blackjack game with a **DOM-free, unit-tested rules engine**, plus an
**autonomous QA loop**: one "creator" side writes/commits the game, one "player"
side QA's every new commit and files bugs back. Two KiroCrew member sessions
drive it, wired together by two zero-token cron scripts.

There is **no production deployment and no remote git** — it is a local
development artifact. It runs as a static site (`index.html` + ES modules) over
`python3 -m http.server`.

## 2. Where everything lives (all local, this machine only)

| Piece | Path | VCS |
|---|---|---|
| **Game source** | `/Users/olivdelm/workplace/kirocrew-workspace/dashboard_member-blackjack-creator` | git, branch `main`, **no remote** |
| **QA harness** (player side) | `/Users/olivdelm/workplace/kirocrew-workspace/dashboard_chat-6-1790362800/qa` | **not** under git |
| **Cron scripts** (the wiring) | `/Users/olivdelm/.kiro/crew/crons/{blackjack_watch.py,blackjack_deliver.py,test_blackjack_watch.py}` | git, **no remote** (commit `6f59b8a`) |

> **No git remote exists for any of these.** To hand off to a machine other than
> this one, you must first push them somewhere (internal GitLab / CodeCommit) —
> `git remote -v` is empty today. The QA harness and the cron scripts would each
> need their own repo + remote too.

## 3. The game (creator repo)

- **Run:** `cd` into the repo, `npm start` → serves on `http://127.0.0.1:8080`. Open `index.html`.
- **Test:** `npm test` (= `node --test`, Node's built-in runner, zero deps). Every module has a `*.test.js`.
- **Architecture:** `blackjack.js` is the pure rules engine (no DOM). `app.js` is the UI glue. Feature modules: `counting.js`, `drill.js`, `strategy.js`, `chart.js`, `ev.js`/`ev-data.js`, `bankroll.js`, `betting.js`, `sidebets.js`, `replay.js`, `report.js`, `rules.js`, `prefs.js`, `stats.js`, `a11y.js`. PWA bits: `sw.js`, `manifest.webmanifest`, `pwa.test.js`.
- **Current HEAD:** `6ec4a0e feat: Add KO, Hi-Opt II and Omega II counting`. Working tree clean.
- `README.md` in the repo is the game's own feature/design doc — read it for gameplay detail.

## 4. The autonomous QA loop (how the two sides talk)

```
creator commits ──► blackjack_watch.py (cron, every 2m, 0 tokens)
                      sees new HEAD on 2 consecutive ticks (debounce)
                      ──► notifies the PLAYER session to run a QA round
                            │
                            ▼
                    player runs qa/PLAYBOOK.md against the new sha
                      (node --test + fuzz + ui_playtest + live_play, screenshots)
                      ──► if any bug open: node qa/publish_handoff.js writes
                            qa/handoff/<sha7>.md  +  qa/handoff/LATEST (atomic)
                            │
                            ▼
              blackjack_deliver.py (cron, every 2m, 0 tokens)
                sees new LATEST on 2 ticks ──► wakes the CREATOR thread to fix
```

- **The authoritative QA procedure is `qa/PLAYBOOK.md`** — a new player agent should read it first. It covers gating on `state.json`, snapshotting the commit (never the working tree), the test battery, backlog/report writing, the handoff helper, and the escalation guards (a bug open after 3 handoffs → escalate to user; creator commits but fixes nothing across 2 rounds → flag).
- `qa/state.json` tracks `last_tested`, `round`, and the tool list. `qa/backlog.md` is the live bug list; `qa/reports/<sha7>.md` per-round reports; `qa/.snapshots/<sha7>/` the archived commit under test.

### Registered crons (KiroCrew)

| ID | Name | Owner session | Script |
|---|---|---|---|
| `fbe48af1` | blackjack-version-watch | `dashboard:member-blackjack-player-26ee0f7dd6e4` | `blackjack_watch.py` |
| `87207070` | blackjack-handoff-deliver | `dashboard:member-blackjack-creator` | `blackjack_deliver.py` |

Both fire every 2 min and cost no tokens (pure disk reads). Ownership matters:
each cron notifies `session="origin"` = its owning session, so the watcher must
be owned by the player and the deliverer by the creator (re-adopt with
`kirocrew cron adopt <id> --session-of <session>` if that ever drifts).

## 5. Load-bearing host constraint (READ THIS before "fixing" the loop)

This macOS host (macOS 26) has **no OS-level sandbox backend**, and `~/.kiro/crew`
is a **macOS Data Vault**: `~/.kiro/crew/{scratch,ledger,.vault,cron-history,...}`
return `Operation not permitted` to any process that is **not the entitled
KiroCrew app**. Consequences a new agent must respect:

- A script cron **cannot `spawn_run` a subagent** — the cron subprocess can't reach
  the data home to set up the child's working dirs. That is why the watcher
  **notifies a session to do the spawn** instead of spawning itself. Only a real
  dashboard/member session (inside the app process) can spawn. Don't "fix" this
  back to a direct cron spawn — it was tried and it's an OS wall, not a bug.
- `kirocrew cron list` from a shell prints `PermissionError` / "cron history
  disabled" noise — that's the Vault denying the CLI subprocess, **not** a
  scheduling failure. Jobs still fire. Manage crons from the dashboard to avoid it.
- **The loop is only autonomous while the owning session is OPEN.** When the player
  thread is closed at fire time, the watcher's notify degrades to a dashboard
  notification — the request is visible, not lost, but a human (or an open
  session) must run the round. This is unavoidable on this host.

## 6. ⚠️ Current drift — a round is owed right now

- Watcher state: `notified = 6ec4a0e` (HEAD) — the watcher **already counted** the latest commit.
- QA state: `last_tested = fadf7e1`.
- So **three commits are un-QA'd**: `b5f9cc7`, `ff08554`, `6ec4a0e`. The request
  fired but the round never ran (player session was closed). A new player agent's
  **first action** is to run a QA round on HEAD `6ec4a0e` per `qa/PLAYBOOK.md`.

## 7. First steps for the new owner

1. Read `qa/PLAYBOOK.md` (player) and the game `README.md` (creator).
2. Decide hosting: to move off this machine, add a git remote to the creator repo
   and push `main`; put `qa/` and the cron scripts under git with remotes too.
3. Clear the owed round: run QA on `6ec4a0e`, update `qa/state.json`.
4. If keeping the crons: confirm ownership (`fbe48af1`→player, `87207070`→creator)
   and keep both member threads open for true autonomy, or accept the
   notify-and-run-on-demand mode.
