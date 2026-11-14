# BlackJack — agent team setup report

Base spec: `.agents/SPEC.md` v0.10 (copied from `delmarolivier/agent-team-template`). Overlay: `.agents/PROJECT.md` (from `projects/blackjack/PROJECT.md`). Setup run from the PC console (`/setup-project delmarolivier/blackjack`).

## Status (2026-11-14)
- Step 0 (spec + overlay copied) and step 1 (inspection) are done, on local branch `agent-team/setup`. Nothing has been pushed.
- **Paused before step 2.** The repo conflicts with the spec in four places (below), so I've stopped to ask H, as `/setup-project` requires.

## Step 1 — inspection (2026-11-14, read-only)

### Stack
- **One JavaScript engine** in `engine/`, shared by the agent CLI and MCP server (`agent/`), the browser game (`web/`, a static PWA), the live table server (`server/`, Node HTTP + SSE) and a macOS app (`macos/`, SwiftPM, with the engine embedded via JavaScriptCore, `EngineJS.generated.swift`).
- Node 18+, with no runtime dependencies (`package.json` has no deps). The `qa/` harness has its own `package.json` (`playwright-core`, which drives an installed Chrome).
- Also in the repo: poker (`engine/poker*.js`, `server/poker-hub.js`, `web/poker.*`, `agent/poker-*.js`) and local-model players that call Ollama (`agent/local-player.js`, `agent/examples/local-model-policy.js`).

### Commands
| Purpose | Command | Notes |
|---|---|---|
| Unit tests | `npm test` (= `node --test`) | **411 tests, all pass, ~30 s** on this PC (Node 22.22.1). Includes the macOS embed check. |
| Engine embed | `node macos/scripts/embed-engine.js` (`--check` to verify) | Must be re-run after engine/agent changes. `npm test` fails if it's stale. |
| QA round | `node qa/run-round.js [sha]` | Runs on a `git archive` snapshot. Needs Chrome + `cd qa && npm ci`. Port 8765 must be free. Writes `qa/reports/<sha7>.md`, updates `qa/state.json`. Currently on round 27, `last_tested` 34b01d2. |
| macOS CI | `macos/scripts/ci.sh` | Swift build + tests + Swift/Node self-play cross-check. **macOS only.** |
| Lint / types | none | No linter, formatter or type checker is configured. |
| Run | `npm start` (static site on :8080), `npm run tables` (live server) | |

### Tests
- Extensive: every engine/web/agent/server module has a `*.test.js`. There are also fuzzers and per-feature checks in `qa/`, and Swift tests in `macos/Tests/`.
- **The spec's P0 assumption ("existing code may lack tests") doesn't hold.** P0 shrinks to writing `REVIEW.md`/`RISK.md`/`CODEOWNERS` and adapting `CLAUDE.md`. No baseline suite needs adding.

### CI, protection, GitHub state
- No `.github/` directory: **no CI at all.** QA rounds are run by hand.
- Private repo on GitHub Free. Branch protection and rulesets API → `403 Upgrade to GitHub Pro` (as expected, D10).
- 136 commits on `main`, nearly all pushed directly. Only 4 PRs ever (#1–#4, merged 2026-10-21/22). Last push 2026-10-24.
- GitHub Issues: none. Labels: GitHub defaults only. Self-hosted runners: 0. Actions secrets: none listed.

### Existing process (conflicts with the spec — see questions)
- **Tracker is Linear, not GitHub.** The repo's `CLAUDE.md` says "Linear is the source of truth": team ClawWorks, projects **BlackJack** and **Poker**, keys `CLA-…`. Commits name the issue, and an issue is Done when its commit is on `main` and a QA round passed. Open now: CLA-100, CLA-101, CLA-103 (BlackJack, backlog), CLA-127 (Poker, in progress), CLA-132 (Poker, unstarted). All other issues are done.
- **No schedulers without asking.** `CLAUDE.md`: "Don't recreate [the KiroCrew crons], or any scheduler, without asking." The spec's `orchestrator.yml` is a scheduler.
- **Deploy.** Nothing is deployed. `server/` is home-network only: "never deploy it or expose it publicly without asking". `server/service.sh` runs it as a launchd agent on the Mac (default host 192.168.4.43), restarted by hand after a pull.
- **Flags.** No feature-flag system. The only env knobs are tooling (`BLACKJACK_SERVER`, `POKER_SCOUTING`, `LOCAL_LLM_CMD`, QA browser vars). Overlay says `flags: env-config # confirm at setup`.
- **History.** `HANDOVER.md` describes an earlier creator/player agent loop on a different host ("KiroCrew"). Its crons are historical and weren't recreated. About 40% of commits use a different author email from the rest.

## Questions for H (step 1 → step 2)
Asked in the console session on 2026-11-14. Answers are recorded here when given.
1. Tracker: Linear vs GitHub Issues (D3, REQ-COMMS-1 non-overridable).
2. What the required `ci` gate runs (no CI today; macOS CI needs a macOS runner; QA round needs Chrome).
3. Flags/deploy: confirm `flags: none` (REQ-FLOW-3 → Tier floor 1) and `deploy: none`.
4. Scope: confirm BlackJack is a personal project (spec §1.2 excludes work-related repos).
