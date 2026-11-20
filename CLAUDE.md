# Claude instructions

Blackjack built for agents first: one JavaScript engine in `engine/`, used by the agent CLI and MCP server (`agent/`), the browser game (`web/`) and the macOS app (`macos/`).

Read README.md, agent/README.md and qa/PLAYBOOK.md first; HANDOVER.md is the history from the old KiroCrew host.

- Change rules only in `engine/`. After engine or agent changes, run `node macos/scripts/embed-engine.js` so the macOS app carries the current engine (`npm test` checks this).
- Validate with `npm test`, then `node qa/run-round.js` on a committed SHA (it tests a `git archive` snapshot, not the working tree). Make sure nothing else is serving port 8765 first. The macOS CI script is `macos/scripts/ci.sh`.
- After every merge, `qa.yml` runs the QA round (`npm run qa:ci`) on the merged SHA on a sandbox VM with headless Chrome, sets a `qa` status on the commit and comments the summary on the PR (full report in the run's artifact). That is the QA record; failures become issues. A round by hand is still fine for a commit that isn't merged yet. Record any manual round in `qa/reports/<sha7>.md` and `qa/state.json`, and file or close the matching GitHub issues. `qa/backlog.md` is an archive (closed at round 14).
- The KiroCrew crons in HANDOVER.md are historical. Don't recreate them, or add any scheduler, without asking. The agent team's own schedules (`orchestrator.yml`, `tier2-cooling.yml`, `main-guard.yml`, `retro.yml`) were approved by Delmar at setup (2026-11-14).
- Agent feedback triage (when Delmar asks): `node agent/feedback.js pending` lists findings from the local-model players (CLA-116). Check each against the code before filing; small-model notes are often wrong. File real ones as GitHub issues (label `agent feedback`, link the evidence), then `node agent/feedback.js mark <fingerprint> --as '#N'`; mark the rest `--as dismissed`.
- `server/` is the live table server (agents and people at one table, AI vs human leaderboard). It is for the home network: never deploy it or expose it publicly without asking. Its data (`server/data/`) stays out of git.

## Backlog: GitHub Issues is the source of truth

Work is tracked in GitHub Issues on this repo plus the GitHub Project "BlackJack delivery" (spec §9). Linear (team ClawWorks, projects BlackJack and Poker, `CLA-…`) is history only: its open issues were moved here on 2026-11-14, each linking back to its `CLA-` key. Don't file new work in Linear.

- Poker work (engine/poker*.js, server/poker-hub.js, web/poker.*, agent/poker-*.js) carries the `area:poker` label; everything else is BlackJack.
- Before starting work, find or open its issue. Name it in commits and PR titles (`#12`, `Closes #12` in the PR body). Old `CLA-` keys stay in history; don't rewrite them.
- An issue is Done when its PR is merged by A9 and its acceptance criteria are verified (G12). For engine/web changes, also a green `qa` status on the merged SHA (qa.yml), and a QA check that covers the issue's browser acceptance criteria.
- Work found along the way becomes a new issue, not a note in the repo.

## Agent delivery team

This repo is run by the agent team in `.agents/SPEC.md` (base) and `.agents/PROJECT.md` (overlay; overlay wins except non-overridable rules). Autonomy level: see the overlay.

- **Never push to `main`.** Every change goes through a PR. A9's `merge.yml` is the only merge path (REQ-GATE-1); `main-guard.yml` reverts anything else (REQ-GATE-2).
- Policy files are read from the base branch: `CLAUDE.md`, `REVIEW.md`, `RISK.md`, `.agents/`, `.claude/`, `.github/`, `scripts/gates/`, `scripts/rollback`. Changing any of them is Tier 2.
- Roles live in `.claude/agents/`; the local implementer is `.agents/local-implementer.md`. Every handoff uses the §9 template (REQ-COORD-1).
- Required gate: `ci` = `npm test`. After merge: `qa.yml` runs `node qa/run-round.js` (Chrome) on the team's sandbox VM. Not run by the team: `macos/scripts/ci.sh` (Mac); A9 flags PRs that need it.
- No feature flags exist (overlay `flags: none`), so every behaviour change is at least Tier 1. Rollback is `scripts/rollback <sha>`.
