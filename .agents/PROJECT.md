project: BlackJack
repo: ClawWorks-Ireland/blackjack   # REQ-OPS-10 (transferred 2026-11-15)
autonomy_level: 0
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
accept_unprotected_autonomy: false   # REQ-CB-6
flags: none   # confirmed 2026-11-14: no flag system; REQ-FLOW-3 Tier floor 1 for behaviour changes
deploy: none   # confirmed 2026-11-14: nothing deployed; server/ is home-network only, run by hand on the Mac (server/service.sh). Release = A9 merge + tag
tracker: github-issues + github-project
solo_owner: true
tier2_cooling_hours: 0   # Delmar 2026-11-15: BlackJack is the test project for the template; Tier 2 still needs his approval, but no cooling wait
orchestrator_schedule: hourly 24x7   # spec v0.11; daily digest at 08:00 Europe/Dublin
sensitive_paths_extra:   # Tier 2 floor, see RISK.md
  - server/**        # live table server, network-facing; never expose publicly
  - .mcp.json
ci_command: npm test   # required `ci` gate; GitHub-hosted ubuntu, ~30 s
manual_checks:   # not gates; A9 notes them on PRs that touch the paths
  - macos/scripts/ci.sh      # Swift build/tests, on the Mac (PR touches macos/ or engine/)
  - node qa/run-round.js     # Chrome QA round (PR touches web/ or engine/)
no_lint_or_types: true   # G4 'lint, types pass' is vacuous here until one is added
