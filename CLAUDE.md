# Claude instructions

Blackjack built for agents first: one JavaScript engine in `engine/`, used by the agent CLI and MCP server (`agent/`), the browser game (`web/`) and the macOS app (`macos/`).

Read README.md, agent/README.md and qa/PLAYBOOK.md first; HANDOVER.md is the history from the old KiroCrew host.

- Change rules only in `engine/`. After engine or agent changes, run `node macos/scripts/embed-engine.js` so the macOS app carries the current engine (`npm test` checks this).
- Validate with `npm test`, then `node qa/run-round.js` on a committed SHA (it tests a `git archive` snapshot, not the working tree). Make sure nothing else is serving port 8765 first. The macOS CI script is `macos/scripts/ci.sh`.
- Record QA results in `qa/backlog.md`, `qa/reports/<sha7>.md` and `qa/state.json`.
- The KiroCrew crons in HANDOVER.md are historical. Don't recreate them, or any scheduler, without asking.
