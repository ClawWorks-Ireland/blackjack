project: BlackJack
repo: ClawWorks-Ireland/blackjack   # REQ-OPS-10 (transferred 2026-11-15)
autonomy_level: 4   # Delmar's decision: BlackJack is the template's test project (spec §7.1; skips §7.2 by his waiver)
revert_ceiling: 3%
wip_limit: 3
billing: subscription-only
models:
  orchestrator: claude-opus
  spec_planner: claude-opus
  implementer_local: ollama/qwen3.5:9b   # attempts: 2, context 32k, slim harness (REQ-CFG-4e, D12 v0.12)
  implementer_fallback: claude-sonnet   # attempts: 2
  reviewers: claude-sonnet
  verifiers: claude-haiku
  security: claude-opus
  classifier: claude-haiku
local_runner_label: local-llm
claude_runner_label: claude-jobs
github_plan: free
platform_protection: none   # gates enforced per §8.3
accept_unprotected_autonomy: true   # REQ-CB-6: set by Delmar; GitHub Free has no platform branch protection; main-guard and the release manager still gate main
flags: none   # confirmed 2026-11-14: no flag system; REQ-FLOW-3 Tier floor 1 for behaviour changes
deploy: none   # confirmed 2026-11-14: nothing deployed; server/ is home-network only, run by hand on the Mac (server/service.sh). Release = A9 merge + tag
tracker: github-issues + github-project
solo_owner: true
tier2_cooling_hours: 0   # Delmar 2026-11-15: BlackJack is the test project for the template; Tier 2 still needs his approval, but no cooling wait
orchestrator_schedule: hourly 24x7   # spec v0.11; daily digest at 08:00 Europe/Dublin
sensitive_paths_extra:   # Tier 2 floor, see RISK.md
  - server/**        # live table server, network-facing; never expose publicly
  - .mcp.json
manual_checks:   # not gates; A9 notes them on merged PRs whose paths match ("<path regex> => <message>")
  - ^(macos/|engine/|agent/) => macOS CI owed on the Mac: `macos/scripts/ci.sh`
  - ^(web/|engine/|index\.html) => QA round owed: `node qa/run-round.js <merge sha>`
no_lint_or_types: true   # G4 'lint, types pass' is vacuous here until one is added
owner_login: delmarolivier   # the sole human approver (H)
test_command: npm test
qa_command: npm run qa:ci   # browser QA round after each merge (qa.yml, team v2.8): sandbox VM, headless Chrome
test_tools:   # commands implementers and verifiers may run to test
  - npm test
  - node --test
implementer_extra_commands:   # project commands implementers may run
  - node macos/scripts/embed-engine.js
implementer_notes: Game rules live only in `engine/`. After changing `engine/` or `agent/`, run `node macos/scripts/embed-engine.js` so the macOS app embeds the current engine (npm test checks it).
node_version: 22
