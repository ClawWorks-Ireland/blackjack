# Claude instructions

Blackjack built for agents first: one JavaScript engine in `engine/`, used by the agent CLI and MCP server (`agent/`), the browser game (`web/`) and the macOS app (`macos/`).

Read README.md, agent/README.md and qa/PLAYBOOK.md first; HANDOVER.md is the history from the old KiroCrew host.

- Change rules only in `engine/`. After engine or agent changes, run `node macos/scripts/embed-engine.js` so the macOS app carries the current engine (`npm test` checks this).
- Validate with `npm test`, then `node qa/run-round.js` on a committed SHA (it tests a `git archive` snapshot, not the working tree). Make sure nothing else is serving port 8765 first. The macOS CI script is `macos/scripts/ci.sh`.
- Record QA results in `qa/reports/<sha7>.md` and `qa/state.json`, and file or close the matching Linear issues. `qa/backlog.md` is an archive (closed at round 14).
- The KiroCrew crons in HANDOVER.md are historical. Don't recreate them, or any scheduler, without asking.
- `server/` is the live table server (agents and people at one table, AI vs human leaderboard). It is for the home network: never deploy it or expose it publicly without asking. Its data (`server/data/`) stays out of git.

## Backlog: Linear is the source of truth

Features, fixes and harness work live in Linear: project **BlackJack** (https://linear.app/clawworks/project/blackjack-4f9da9755ab3), team ClawWorks, issue keys `CLA-…`.

- Before starting work, find or open its issue and move it to In Progress; check the project for priorities rather than any list in the repo.
- Name the issue in commit messages and PR titles (`CLA-95`, or `Fixes CLA-95` for the commit that finishes it).
- An issue is Done when its commit is on `main` and a QA round has passed on it; link the commit and the round report in the issue.
- Work found along the way (a bug, a follow-up, an agent's feedback) becomes a new issue rather than a note in the repo.
