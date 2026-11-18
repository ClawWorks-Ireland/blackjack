# Claude Agent Delivery Team — Requirements & Design Spec

**Version:** 0.16 · **Date:** 2026-11-17 · **Owner:** Delmar (sole human approver, "H")
**Status:** Control plane bootstrapped (Phase 2 + reboot test done). BlackJack setup open as ClawWorks-Ireland/blackjack#11 (Tier 2, Level 0). Next: its checklist, then merge (§13).

---

## 0. Decisions locked (v0.2 + v0.3)

| # | Decision | Choice |
|---|---|---|
| D1 | Runtime | GitHub-native: private repos in the **`ClawWorks-Ireland`** organisation (H is admin; REQ-OPS-10), Claude Code GitHub Action for review/security/classification, scheduled runs for the Orchestrator |
| D2 | Local models | Ollama/Qwen as **Implementers only**; Claude implementer takes over after 2 failed attempts on a slice |
| D3 | Tracker | GitHub Issues + GitHub Projects |
| D4 | Human approvers | Solo owner. Tier 2 = H's approval + 24h cooling period |
| D5 | Review layer | Build our own bug hunters + voting verifiers (not Anthropic's Code Review product) |
| D6 | Budget | Claude subscription only — no API spend. Work throttles at usage limits |
| D7 | Pilot | BlackJack (existing, low-risk project) |
| D8 | Local runner host | The Windows PC (study). Runner inside WSL2, Ollama on Windows for direct GPU access |
| D9 | Local harness | **Confirmed by P1 (2026-11-14):** Claude Code pointed at Ollama's Anthropic-compatible endpoint (Ollama ≥ 0.14), in a *slim* configuration (REQ-CFG-4e). Fallback: Qwen Code |
| D10 | GitHub plan | **GitHub Free, private repos.** No platform branch protection, rulesets, enforced CODEOWNERS or merge queue. Gates are enforced by the team's own workflows (§8.3) |
| D11 | Agent identity | **One GitHub App per agent role** in `ClawWorks-Ireland` (§8.5), plus one for the console. Every agent write is attributable to its role, and permissions are per role. Agents never use H's credentials, so H can approve every agent PR and H's approval is the only human one |
| D12 | Local model | `qwen3.5:9b`, 32k context, native tool calls (P1 2026-11-14: 2/5 without fallback, no hangs or overflows). `qwen2.5-coder:14b` failed P1: through Ollama it returns tool calls as text, never as tool calls (0/5). Host: RTX 4060 Ti 16 GB VRAM, 16 GB system RAM. Larger Qwen models (e.g. qwen3-coder:30b) need ≥ 32 GB system RAM for offload |
| D13 | Operator access | One permanent control plane (§8.4): GitHub template repo holds spec and state; a Claude Code Remote Control service on the Windows PC is H's console from any device; no per-task session linking |

---

## 1. Purpose, scope, iteration

### 1.1 Purpose
A team of Claude agents (plus local implementer models) takes a project from backlog item to staged release. H's role shrinks only as measured quality allows.

### 1.2 Scope
- **In:** software projects in one private GitHub repo.
- **Out (v0.2):** non-code deliverables, multi-repo work, anything work-related or tied to home systems until the pilot passes.

### 1.3 Iteration protocol
- Base spec lives at `.agents/SPEC.md` in a template repo (`ClawWorks-Ireland/agent-team-template`) and is copied into each project.
- Each change bumps the version and adds a Changelog line (§14): what, why (metric/incident/pilot result), affected REQ IDs.
- Changes to the spec, `CLAUDE.md`, `REVIEW.md`, `RISK.md`, agent definitions or workflows are **Tier 2**.

### 1.4 Base + overlay
- Base = this spec. Overlay = `.agents/PROJECT.md` (stack, commands, sensitive paths, autonomy level, flags, deploy).
- Overlay wins on conflict, except rules marked **non-overridable**.

---

## 2. Source model (summary)
From the Claude Code team's "How the Claude Code team does code review" (15 Oct 2026):
- Objective: least human review time that doesn't raise reverts or incidents.
- Layers: pre-PR self-verification + fresh-context review → parallel bug hunters + voting verifiers → blocking security review → required CI → risk-tiered human approval (0/1/2) → merge queue, flags, staged release → fast rollback.
- Agent approvals never count as human approvals. REVIEW.md read from the protected base branch. Round cap. Small PRs. Incidents become evals.
- Gap they acknowledge: no automatic circuit breakers. This spec adds them (§7.3).

---

## 3. Design principles
1. Verify, don't trust — every output is checked by something that didn't produce it.
2. Small, reversible units: one item → one PR (< ~400 lines) → one flag.
3. Policy is read from the protected branch only.
4. Human attention is the scarcest resource; subscription usage is the second scarcest.
5. Autonomy is earned by metrics and revoked automatically.
6. Roles are separated by permissions, not just prompts.
7. Local models do volume work; Claude does judgement and verification.

---

## 4. Team roster

| # | Role | Runs on | Where | Can | Cannot |
|---|---|---|---|---|---|
| A0 | Orchestrator | Claude (Opus) | Scheduled GitHub Action | Manage issues/Project board, dispatch work, escalate | Write code, approve, merge |
| A1 | Spec Writer | Claude (Opus) | Action, on issue label | Write spec as issue body/comment | Write code |
| A2 | Planner | Claude (Opus) | Action, on spec approval | Create sub-issues (slices) with tier estimate + test plan | Write code |
| A3a | **Local Implementer** | **Ollama / Qwen** | **Self-hosted runner `local-llm` on H's machine** | Edit code in its worktree, run tests (read-only job token; its patch is published by a separate model-free job as `clawworks-local-coder`) | Approve, merge, edit policy files, hold any App key |
| A3b | Claude Implementer (fallback) | Claude (Sonnet) | Self-hosted runner `claude-code` | Same as A3a (published as `clawworks-claude-coder`) | Same as A3a |
| A4 | Self-Verifier | Claude (Sonnet) | Same runner, before PR | Read diff, run tests, comment | Edit code |
| A5 | Bug Hunters ×3 | Claude (Sonnet) | Action on PR | Post candidate findings | Edit, approve |
| A6 | Finding Verifiers ×3 | Claude (Haiku/Sonnet) | Action on PR | Vote, tag Important/Nit/Pre-existing | Edit, approve |
| A7 | Security Reviewer | Claude (Opus) | Action on PR | Blocking status check | Edit, waive own findings |
| A8 | Risk Classifier | Claude (Haiku) | Action on PR | Set tier label + rationale | Lower a path-rule floor |
| A9 | Release Manager | **No model:** fixed `scripts/gates/gate.js` / `scripts/rollback` steps | GitHub-hosted runner, as `clawworks-release-manager` | Merge (all gates green), update branches, revert, rollback | Approve, edit code |
| A10 | Incident & Retro | Claude (Opus) | Action, on revert + weekly | Write evals, open Tier 2 proposal PRs | Merge own proposals |

**Requirements**
- `REQ-ROLE-1` Each role is a separate agent definition (`.claude/agents/*.md` or workflow job) with a tool/permission allowlist enforcing Can/Cannot.
- `REQ-ROLE-2` Reviewer roles (A4–A7) never share context with the authoring agent. *(non-overridable)*
- `REQ-ROLE-3` Bug hunters submit blind to each other.
- `REQ-ROLE-3a` **Checked examples.** Reviewers can't run code, so a hunter's failing input is reasoned (the dry run found 2 of 5 examples wrong). A hunter may attach a `check`, a Node program that exits 0 when the code is right. A model-free `repro` job runs each check on the PR head and on main, on a fresh **GitHub-hosted VM**, never the PC. The PR's install and every check run as a throwaway `sandbox` account that can't write the gate script or the results. Each check gets a fresh copy, no network, an empty environment and a 10 s limit, in its own PID namespace, so nothing it starts outlives it. Each hunter's ids must belong to its own lens, once each. An Important finding whose check passes on the PR is downgraded to a Nit, with the reason in the review. A check can only weaken a finding, never add one. A deliberately evasive PR could still make its own code pass a check (as it can its own tests); the security review and H's approval still stand.
- `REQ-ROLE-4` No agent approves or merges its own work; agent approvals never satisfy a required human approval. *(non-overridable)*
- `REQ-ROLE-5` **Local models never review, verify, classify or approve anything** — implementation only. *(non-overridable)*
- `REQ-ROLE-6` Bug hunters reduced from 5 to 3 lenses to conserve subscription usage: (1) logic & edge cases, (2) state/concurrency & error handling, (3) contract & test adequacy. Raise to 5 for Tier 2 PRs.

---

## 5. Lifecycle and gates

```
Issue → Spec → Plan (slices) → [Local implement (≤2) → Claude implement (≤2) → Self-verify → PR
 → AI review ⇄ fix (≤3 rounds) → Security → CI → Classify → Human gate by tier (+24h for Tier 2)
 → A9 serial merge] → Flagged release → Verify → Done | Rollback → Incident
```

| Gate | Owner | Exit criteria | H involved? |
|---|---|---|---|
| G1 Intake | A0 | Issue has goal, user, success signal | Level 0–1 |
| G2 Spec | A1 | Testable acceptance criteria; open questions listed | New features at Level ≤2 |
| G3 Plan | A2 | Slices < ~400 lines, ordered, tier + test plan each | Only if any slice is Tier 2 |
| G4 Implement | A3a → A3b | Tests written first and pass; build, lint, types pass | No |
| G5 Self-verify | A4 | No open Important findings | No |
| G6 AI review | A5+A6 | No open Important; ≤ 3 rounds | No |
| G7 Security | A7 | No open findings (blocking) | Only to waive (Tier 2) |
| G8 CI | CI | Required checks green | No |
| G9 Risk gate | A8 → H | Approvals per tier; Tier 2 cooling elapsed | Per §6 |
| G10 Merge | A9 | Branch up to date with main, checks re-run green, all gates verified by A9's merge workflow (REQ-GATE-1); one PR at a time | No |
| G11 Release | A9 | Staged flag ramp with health checks | Tier 2 final ramp |
| G12 Done | A0 | Acceptance criteria verified; issue closed | No |

**Requirements**
- `REQ-FLOW-1` Review round cap = 3; a 4th round escalates to A2 (re-slice) or H.
- `REQ-FLOW-2` **Implementer escalation ladder:** local Qwen gets 2 attempts per slice (an attempt = implement + run full test suite). On the 2nd failure, hand to the Claude implementer with the failing test output and the local diff as context. Claude gets 2 attempts; on failure, back to A2 for re-slicing. **Infrastructure isn't an attempt:** a job that fails (runner lost, timeout, Ollama not serving the model, checked before each local attempt, or a model that never answered) re-runs the same rung once. A local rung that fails on infrastructure twice goes straight to the Claude coder.
- `REQ-FLOW-3` Behaviour changes ship behind a flag unless the overlay says no flag system exists (then Tier floor = 1).
- `REQ-FLOW-4` One-step rollback available to A9 and H; tested in §11.
- `REQ-FLOW-5` Nits never block; Pre-existing findings become new issues.
- `REQ-FLOW-6` WIP limit: 3 open PRs per project (lowered from 5 for subscription-only usage).
- `REQ-FLOW-7` Every local→Claude handoff is logged with the reason, so local-model success rate can be measured (§10).

---

## 6. Risk tiers (solo owner)

| Tier | Examples | Requirement |
|---|---|---|
| **0 — Low** | Docs, comments, test-only, copy | 0 human approvals |
| **1 — Standard** | Flagged features, covered refactors, UI | H approves (→ 0 at Level 4) |
| **2 — Sensitive** | Auth, secrets, CI/CD & workflows, deploy config, data migrations/deletes, dependency major bumps, anything irreversible, agent policy files | **H approves + 24h cooling period**; H can cancel during cooling |

- `REQ-RISK-1` Path rules in `RISK.md` set the floor; A8 may raise, never lower. (`CODEOWNERS` is kept for documentation only — GitHub Free doesn't enforce it on private repos.)
- `REQ-RISK-2` A8 posts a one-paragraph rationale on every PR.
- `REQ-RISK-3` Tier 2 cooling: a required status check `tier2-cooling` stays pending until 24h after H's approval; any new push restarts it.
- `REQ-RISK-4` Approval requests batch into one daily digest (GitHub issue comment + notification), unless a Tier 2 release is blocked.

---

## 7. Autonomy ladder

### 7.1 Levels
| Level | H still does |
|---|---|
| 0 Shadow | Approves every spec, plan and PR |
| 1 Supervised | Specs + Tier 1/2 PRs; Tier 0 auto-merges |
| 2 Gated | New-feature specs + Tier 1/2 PRs; plans auto-proceed |
| 3 Risk-only | Tier 2 + weekly audit of a 10% sample of auto-merged Tier 1 |
| 4 Exception-only | Tier 2 + escalations + weekly metrics review |

### 7.2 Promotion (all, over 4 weeks and ≥ 40 merged PRs; proposed by A10, approved by H)
- Revert rate ≤ baseline and ≤ 3%
- No Sev-1/Sev-2 incidents from agent changes
- First-round review pass rate ≥ 70%
- Reviewer precision ≥ 80% (sampled)
- No misses found in H's audits

### 7.3 Circuit breakers (automatic, non-overridable)
- `REQ-CB-1` Revert rate over ceiling for 2 weeks → drop one level, notify H.
- `REQ-CB-2` Sev-1 caused by an agent change → Level 1 until the retro closes.
- `REQ-CB-3` Security miss found post-merge → Tier 2 floor for that area for 2 weeks + eval case.
- `REQ-CB-4` **Usage limits (subscription-only):** when Claude usage limits are hit, (a) stop starting new slices, (b) finish in-flight reviews first — reviews outrank implementation, (c) resume automatically when limits reset, (d) report throttled hours in the daily digest. Never skip or degrade a review gate to save usage. *(non-overridable)*
- `REQ-CB-5` **Unauthorised change to main:** any `main-guard` revert (REQ-GATE-2) → drop to Level 0 until the retro closes. *(non-overridable)*
- `REQ-CB-6` **Autonomy cap without platform protection:** a repo without platform branch protection (GitHub Free private) cannot be promoted past Level 2 unless H sets `accept_unprotected_autonomy: true` in `PROJECT.md` (a Tier 2 change).

---

## 8. Configuration

### 8.1 Files (protected default branch)
| File | Purpose |
|---|---|
| `CLAUDE.md` | < 200 lines: stack, build/test/lint commands, conventions, how to verify work |
| `REVIEW.md` | What reviewers check here; known footguns; Important vs Nit |
| `RISK.md` / `CODEOWNERS` | Tier path rules (RISK.md is authoritative; CODEOWNERS documentation only on Free) |
| `.agents/SPEC.md` / `.agents/PROJECT.md` | Base spec / overlay |
| `.claude/agents/*.md` | One definition per role (A9's describes its fixed steps) |
| `.agents/local-implementer.md` | Prompt + harness config for the Qwen implementer (`.agents/local-harness/`, `scripts/agents/`) |
| `.agents/local-harness/settings.json`, `scripts/agents/policy-guard.js` | Local implementer permissions and the hook that blocks policy-file edits and credential reads (Claude jobs set theirs in the workflow's `claude_args`) |
| `.github/workflows/` | `ci.yml` (+ actionlint), `orchestrator.yml`, `spec-plan.yml`, `implement.yml`, `review.yml`, `security.yml`, `classify.yml`, `review-submitted.yml`, `tier-approval.yml`, `tier2-cooling.yml`, `merge.yml`, `main-guard.yml`, `release.yml`, `retro.yml`. All rendered from the template's `team/` (REQ-OPS-11) |
| `evals/review/` | Seeded-bug and past-incident cases |
| `scripts/rollback` | One-step rollback |

### 8.2 Platform
- `REQ-CFG-1` Required gates on every PR: `ci`, `ai-review`, `security`, `tier-approval`, `tier2-cooling` (Tier 2). On GitHub Free these are enforced by A9's merge workflow and `main-guard` (§8.3), not by GitHub. If the repo later gains platform protection, also configure them as required checks in a ruleset.
- `REQ-CFG-2` Implementers run in isolated git worktrees, one slice per worktree.
- `REQ-CFG-3` **Runners and keys.** Three self-hosted runners on the PC, each its own Linux user with no sudo, none able to read another's files or `/mnt/c`: `local-llm` (`gh-llm`, local implementer), `claude-code` (`gh-code`, the Claude jobs where a model runs code: A3b, A4, A10) and `claude-jobs` (`gh-claude`, the other Claude jobs). **No App private key is ever on a runner where a model runs code**, and jobs where a model runs code get a read-only `GITHUB_TOKEN`. The model-free jobs that hold a writing key (A9's merge/revert/rollback, the coders' publish, A10's publish) run on GitHub-hosted runners. Every Claude step, and the local implementer, is denied reads of the runner's credentials (in any `~/actions-runner*` directory), `~/.claude` and `/proc`, by deny rules and by `scripts/agents/policy-guard.js` as a hook (frozen before the model starts; in Claude jobs it also refuses `gh` flags that read local files). This check is **best-effort** defence in depth (Delmar, 2026-11-17): on the code runners a test run can read the runner's files, which is why no key lives there. A way around it is a Nit for reviewers, not a blocker; key placement and token scopes are the boundary that blocks. **A job holding a writing key or token runs no repo code:** the tests that guard a release, tag or rollback run in a separate job with a read-only token, before the key job. Each job starts from a fresh checkout and reads `REVIEW.md`/`RISK.md` from the base branch, never the PR head. Actions minutes used are reported in the digest.
- `REQ-CFG-4` **Local implementer host:** a self-hosted GitHub Actions runner on the Windows PC, labelled `local-llm`. Implementation jobs target that label. If the host is offline, slices queue (they don't fall back to Claude just because the machine is asleep).
  - `REQ-CFG-4a` Runner runs inside WSL2 (Claude Code, worktrees and bash scripts behave predictably there); Ollama runs natively on Windows for GPU access and is reached from WSL2 via localhost (mirrored networking).
  - `REQ-CFG-4b` Runner is installed as a service started at boot, so it survives logouts and reboots (lesson from SecureClaw, whose unattended jobs depended on the Windows user staying logged in).
  - `REQ-CFG-4c` Power settings: the PC runs 24x7, no operating-hours window. Sleep and hibernate are off on AC power (power plan timeouts set to 0/never); setup checks this took effect.
  - `REQ-CFG-4d` Gaming pause: a Windows scheduled task pauses the `local-llm` runner while a game is running (shared GPU); queued slices wait. The `claude-jobs` runner keeps running (it uses no GPU). If the PC is off, reviews queue too — gates are never skipped.
  - `REQ-CFG-4e` Local harness per D9. Claude Code env for local jobs: `ANTHROPIC_BASE_URL=http://localhost:11434`, `ANTHROPIC_AUTH_TOKEN=ollama`, all model tiers mapped to `qwen3.5:9b`, context 32k (`OLLAMA_CONTEXT_LENGTH=32768`), and Claude Code told that window (`CLAUDE_CODE_MAX_CONTEXT_TOKENS=32768`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=32768`). **Slim harness:** `--system-prompt` replaces the default prompt with the local implementer's own, and `--tools` offers only Read, Edit, Write, Bash, Grep, Glob (~4.9k tokens on turn one, against ~26k by default, which overflows 32k after two file reads). Never `--bare`: it would skip the policy-file hook. Fallback jobs unset these and use the subscription token.
- `REQ-CFG-5` **Subscription auth:** Claude jobs authenticate with a Claude subscription OAuth token stored as a repo/org secret, not an API key. Verify at setup that every workflow uses it.
- `REQ-CFG-6` Orchestrator runs on cron every 60 min, 24x7, plus event triggers (issue labelled, PR merged, check failed).
- `REQ-CFG-7` Secrets never in agent context; deploy credentials only in the release job.

### 8.3 Software gates (GitHub Free)
GitHub Free doesn't enforce branch protection on private repos, so the team enforces its own gates. Protection is **detective** (unauthorised changes are caught and reverted within minutes), not preventive.
- `REQ-GATE-1` **Single merge path:** A9's `merge.yml` is the only way changes reach `main`. Before merging it verifies, on the PR's latest head: all required gates green (REQ-CFG-1), the tier's approvals present from `@delmarolivier` (approvals from the App or any bot never count), `tier2-cooling` elapsed for Tier 2, and the branch up to date with `main` — if not, it updates the branch, waits for gates to re-run, and re-verifies. Merges run one at a time (workflow concurrency group). *(non-overridable)*
- `REQ-GATE-2` **main-guard:** `main-guard.yml` runs on every push to `main` and judges only first-parent commits (a merge's branch commits are covered by the merge's own verdict). Any commit that is not a merge by **the A9 App** (`clawworks-release-manager[bot]`) of a PR carrying trusted gate evidence, or an exact revert (`scripts/rollback`, main-guard's own), is automatically reverted, labelled `incident`, @-mentions H and trips REQ-CB-5. The guard is armed by a marker file (`.github/main-guard.active`): a commit whose parent lacks it is the bootstrap and is exempt. *(non-overridable)*
- `REQ-GATE-3` **Identity:** every agent write uses **its own role's App token** (§8.5). Agents never receive H's personal token or credentials, and never another role's token. Gate results count only as statuses created by `github-actions[bot]` (deterministic workflow steps), and approvals only as H's GitHub review on the PR's current head. H does not merge by hand; H's routes to `main` are approving PRs (A9 merges) and `scripts/rollback`.
- `REQ-GATE-4` The gate workflows (`merge.yml`, `main-guard.yml`, `tier-approval.yml`, `tier2-cooling.yml`) and their scripts are Tier 2 paths. Any PR touching `.github/workflows/` @-mentions H regardless of tier. **No agent identity except A9 holds the `workflows` permission**, so no agent can *write* a workflow change: an agent proposes it (as a patch in its PR), and H applies it as a commit on that agent-opened PR, which the gates then review. A9 holds `workflows` only because GitHub requires it to merge or revert such PRs; its token is only ever given to the one-command merge/revert step, which merges exactly the head H approved. *(non-overridable)*
- **Residual risk (accepted at Level ≤ 2):** an agent with write access could push directly to `main`, including to the guard itself. Mitigations: H approves all Tier 1/2 work, main-guard reverts and alerts, REQ-CB-5/CB-6, and the weekly digest lists every commit on `main` with its merge evidence.

### 8.4 Operator access (control plane)
How H works *on* the team (setup, spec changes, troubleshooting), as opposed to the team working on projects. Goal: one durable setup, no session scaffolding.
- `REQ-OPS-1` **State lives in GitHub.** `ClawWorks-Ireland/agent-team-template` holds `.agents/SPEC.md`, decision history (Changelog) and `.agents/SETUP_REPORT.md`. Chat sessions are disposable; any session starts by reading the repo. Spec changes are Tier 2 PRs to the template repo (§1.3).
- `REQ-OPS-2` **One console on the runner host.** The Windows PC runs Claude Code inside WSL2 as `claude remote-control --spawn worktree` in a home working folder, installed as a systemd service that starts at boot and restarts on failure. H reaches it from any device via claude.ai/code or the Claude mobile app; each conversation gets its own worktree.
- `REQ-OPS-3` **No inbound access required for the team.** Runners connect outbound to GitHub; team jobs reach Ollama on localhost (WSL2 via mirrored networking). Ollama also stays reachable on the home LAN for the Mac's `local-models` skill and Home Assistant — H's decision (2026-11-13); setup must not change Ollama's listen address or firewall rules.
- `REQ-OPS-4` **SSH from the Air is break-glass only** — for when the console service is down. Key-based login only; password authentication disabled in `sshd_config`.
- `REQ-OPS-5` The console session authenticates with H's Claude subscription. It is an operator tool, not a team role, and it never approves PRs. **In the template repo it acts as H** (no gates there; spec changes are H's decisions). **In project repos it pushes branches and opens PRs as the console App** (`clawworks-console[bot]`), so H can approve them and every change goes through REQ-GATE-1. Its App private key lives only on the PC, readable only by `delmar`.
- `REQ-OPS-9` **Unattended start:** Ollama runs as `ollama serve` from a Windows startup task that runs whether or not anyone is logged on (tray-app autostart off, so only one instance holds port 11434), and the WSL distro is started at boot by a startup task and kept running (`vmIdleTimeout=-1` in `.wslconfig`). After a reboot with nobody logged in, the console, both runners and Ollama must all come back.
- `REQ-OPS-11` **The template is the source of the team.** The team's files (workflows, gates, agent definitions, local harness, schemas, eval runner) live in the template's `team/` folder, versioned in `team.version`, with project values as `{{PLACEHOLDERS}}` filled from the overlay by `scripts/team/render.js`. Projects never hand-edit rendered files. A team fix is made in the template first, then re-rendered into each project by a normal gated PR. `render.js --check` (drift check) must report no drift, including file modes and team files a newer template dropped (tracked in `.agents/TEAM_FILES`, listed on re-render and deleted with `--prune`; project-owned paths are never pruned). Overlay values that reach shells must be plain commands; the renderer rejects anything else. CI runs the gate tests itself, whatever the project's test runner. Project-owned files (CLAUDE.md, REVIEW.md with its Lens hints, RISK.md, CODEOWNERS, the overlay, evals, `risk-rules.test.js`, the main-guard marker) stay in the project.
- `REQ-OPS-12` **PC prerequisites** (bootstrap and maintenance): WSL keep-alive task with a boot trigger **and** a 5-minute repeat (a boot trigger alone doesn't recover from `wsl --shutdown`); `/etc/wsl.conf` automount `uid=1000,umask=077` so runner users can't read or run anything on `C:`; `unzip` (needed by claude-code-action) and `gh` from GitHub's apt repo (Ubuntu's old `gh` breaks `gh pr edit`); the console keeps Ubuntu patched.
- `REQ-OPS-10` **Projects live in `ClawWorks-Ireland`.** The template repo, every project repo and each project's GitHub Project are owned by the organisation, so the agent Apps (§8.5) are installed once for the org with access to **all its repositories** (H's decision, 2026-11-15) and can reach org-owned Projects (user-owned Projects are closed to Apps). Each project's gates only watch that project, so every job requests its role's token **for its own repository only** (`repositories:` on the token request), and the first live run of every project checks that. `/setup-project` expects `ClawWorks-Ireland/<repo>` and asks H before using a repo anywhere else. The org called `clawworks` is unrelated and is never used.
- `REQ-OPS-6` The console is available 24x7 — the host never sleeps (REQ-CFG-4c). If unreachable, H uses break-glass SSH or waits; the team's queued work is unaffected.

---

### 8.5 Agent identities (D11)
| App (`ClawWorks-Ireland`) | Roles | Repository permissions | Org |
|---|---|---|---|
| `clawworks-orchestrator` | A0 | issues: write, pull requests: read, actions: write (dispatch) | Projects: write |
| `clawworks-spec-writer` | A1 | issues: write | — |
| `clawworks-planner` | A2 | issues: write | — |
| `clawworks-local-coder` | A3a (publishing its slices) | contents: write (branches), pull requests: write, issues: write | — |
| `clawworks-claude-coder` | A3b | contents: write (branches), pull requests: write, issues: write | — |
| `clawworks-self-checker` | A4 | pull requests: read (its result is posted by the workflow) | — |
| `clawworks-bug-hunter` | A5 ×3–5 | pull requests: read | — |
| `clawworks-finding-checker` | A6 ×3 | pull requests: read | — |
| `clawworks-security-reviewer` | A7 | pull requests: read | — |
| `clawworks-risk-classifier` | A8 | pull requests: write (labels, rationale) | — |
| `clawworks-release-manager` | A9 | contents: write, pull requests: write (merge, update branch, revert, rollback), **statuses: read, checks: read** (re-verifying gates), **workflows: write** (merging and reverting PRs that change workflows) | — |
| `clawworks-incident-reviewer` | A10 | contents: write (branches), pull requests: write, issues: write | — |
| `clawworks-console` | the PC console (REQ-OPS-5) | contents: write (branches), pull requests: write, issues: write | — |
All Apps also have metadata: read. **None has administration or secrets permissions, and only A9 has `workflows`** (REQ-GATE-4).

- `REQ-ID-1` Each workflow job requests a short-lived installation token for its role's App (`actions/create-github-app-token`, scoped to the job's repository) and passes **only that token** to the Claude step (`github_token`). Private keys are org secrets (`<ROLE>_APP_ID`, `<ROLE>_APP_KEY`) available to the project repos; agents never see a key.
- `REQ-ID-2` GitHub Free has no Environments for private repos, so every workflow could technically read every key. That's acceptable because workflows are H-controlled (REQ-GATE-4: no agent can change them) and every workflow change is reviewed. A repo with Environments must scope each key to its role's environment.
- `REQ-ID-3` Deterministic gate steps keep using `GITHUB_TOKEN` (`github-actions[bot]`). Gate trust (REQ-GATE-3) doesn't move to the agent Apps, so an agent can never post a status that satisfies a gate.
- `REQ-ID-4` Every agent comment, commit and PR is authored by its role's App, so "who did what" is visible in GitHub itself. App names say what the agent does; the A-numbers stay as short IDs in this spec, and handoff lines lead with the name (`ROLE: Release Manager (A9)`). The §9 handoff `ROLE:` line stays as a cross-check.
- `REQ-ID-6` **Exact permissions, pinned action.** Every token request asks only for what the job uses (a subset of its App's grant), and `actions/create-github-app-token` is pinned to a commit SHA. Read-only roles that run `claude-code-action` on PR events need `contents: read`: the action fetches the base branch.
- `REQ-ID-7` **claude-code-action facts** (learned 2026-11-15/16): `--agent` disables `--json-schema`, so roles load with `--append-system-prompt-file`; its own App-token exchange rejects `pull_request_target`, so every job passes `github_token`; runs started by bots are refused unless listed in `allowed_bots`; Claude Code `:*` permission rules match whole words only.
- `REQ-ID-8` **Where the App keys live.** The org is on GitHub Free, where org secrets don't reach private repos (tested 2026-11-17), so every project holds its own `<ROLE>_APP_ID/_KEY/_SLUG` repo secrets. Their source is one key per keyed App (A0–A3b, A5–A10; not A4 or the console) kept on the PC in `~/.config/clawworks/app-keys/` (folder 700, files 600, under the console user, whose home the runner users can't read), with the subscription token in `~/.config/clawworks/claude-oauth-token`. `scripts/github-apps/import-keys.js` files fresh downloads after checking each key against its App and deletes the downloads; `scripts/github-apps/repo-secrets.js` sets a repo's secrets from them on stdin. Keys never go into chat, files in a repo, or logs. If the org moves to a paid plan, org secrets replace the per-repo copies.
- `REQ-ID-5` Apps are created with `scripts/github-apps/create-apps.js` (GitHub's manifest flow; definitions in `roles.json`). Each App's ID, key and slug are stored as repository secrets (`<ROLE>_APP_ID`, `_KEY`, `_SLUG`) on the project repo. The console App's key stays on the PC (`~/.config/clawworks/`, mode 600).

## 9. Coordination

- **System of record:** GitHub Issues + an org-owned GitHub Project per repo (REQ-OPS-10). Parent issue per feature, sub-issues per slice; PRs link with `Closes #n`.
- **Project status field:** Backlog → Spec → Planned → In progress → In review → Awaiting human → Cooling → Merging → Releasing → Done / Blocked.
- **Labels:** `tier:0/1/2`, `impl:local`, `impl:claude`, `round:n`, `needs-human`, `throttled`.
- `REQ-COORD-1` Every handoff is an issue/PR comment in this template:
  ```
  ROLE: <A3a Local Implementer>   ITEM: #<n>   RESULT: done | blocked | needs-human
  WHAT CHANGED: …
  EVIDENCE: <test summary / run link>
  RISKS / ASSUMPTIONS: …
  NEXT: <role or @delmarolivier + exact question>
  ```
- `REQ-COORD-2` Questions for H are yes/no or multiple choice, recommended option first.
- `REQ-COORD-3` No state lives only in an agent's context.
- `REQ-COORD-4` Daily digest (pinned issue, updated 08:00 Dublin): shipped, in flight, exact asks of H, Tier 2 items cooling, throttled hours, metric deltas.

### 9.1 Communication flow
GitHub is the only communication channel — between agents, and between agents and H. There is no chat channel. Agents "talk" by writing to GitHub (comment, label, status, PR, check result); the write fires a GitHub event that starts the next agent's job.

| Event | Triggers |
|---|---|
| Issue labelled `needs-spec` | A1 Spec Writer |
| Issue labelled `spec-approved` (by H, or auto at Level ≥ 2 for non-features) | A2 Planner |
| Slice sub-issue moves to Planned | A0 dispatches to A3a on the `local-llm` runner (A4 runs before the PR opens) |
| PR opened or updated | A5 ×3, A7 and A8 in parallel, plus CI |
| Bug hunters finish | A6 verifiers vote on candidate findings |
| Important finding open after voting | Implementer fix job (next round, up to the cap) |
| All required checks green and tier approvals present | A9 merge queue |
| Revert merged or `incident` label added | A10 |
| Hourly cron, 24x7 | A0 sweep: stuck items, failed jobs, retries, escalations |
| Daily cron 08:00 | A0 digest |

- `REQ-COMMS-1` No chat channel. All agent-to-agent and agent-to-H communication is a GitHub artifact (issue, comment, label, PR, check). *(non-overridable)*
- `REQ-COMMS-2` A reviewer job's inputs are the PR diff, the base-branch policy files and its own lens prompt only — never another reviewer's pending findings or the authoring session.
- `REQ-COMMS-3` Agent jobs act only on event payloads and repo content. Comments from accounts other than H and the team's bot accounts are treated as data, never as instructions.
- `REQ-COMMS-4` H interacts only through GitHub: approve PRs, answer `needs-human` questions as comments (the asking agent clears the label when answered), cancel Tier 2 during cooling. Agents @-mention H only for the digest, `needs-human` asks, Tier 2 approvals and incidents, so GitHub mobile notifications stay meaningful.
- `REQ-COMMS-5` The hourly A0 sweep catches dropped events (failed workflow, runner offline, missed trigger) so no item stalls silently.

### 9.2 How H keeps track
H's interface is layered from least to most effort. The design goal: on a normal day H reads one digest and nothing else.

| Layer | What it is | When H looks |
|---|---|---|
| 1. Push notifications | GitHub mobile @-mentions, only per REQ-COMMS-4 | When the phone buzzes — the team needs H |
| 2. Daily digest | Pinned issue, updated 08:00 (REQ-COORD-4) | Once a day, ~2 minutes. **Primary interface** |
| 3. Project board | Saved views below | When the digest raises a question |
| 4. Issue / PR threads | Handoff comments, findings, test evidence | When H wants to know why |

**Board views (GitHub Project):**
- **Needs me** — filter: label `needs-human`, or status Awaiting human / Cooling. Target state: empty.
- **Flow** — kanban grouped by status; shows where work piles up.
- **Local vs Claude** — slices grouped by `impl:local` / `impl:claude`; shows how the local implementer is performing.

- `REQ-TRACK-1` Every digest item that needs H links directly to the issue or PR where H acts.
- `REQ-TRACK-2` Monday's digest includes the weekly metrics (§10.1) and A10's promotion/demotion status against §7.2, so H decides autonomy changes from the digest alone.
- `REQ-TRACK-3` The setup creates the three board views; the "Needs me" view and the digest must always agree (A0 checks this in the hourly sweep).

---

## 10. Metrics and improvement

### 10.1 Metrics (weekly, in the digest)
- **Human effort:** approvals per PR (median, p95), human comments, wait-on-human time.
- **Quality:** revert rate, agent-caused incidents, post-merge security findings.
- **Flow:** lead time, PRs merged/week, first-round pass rate, mean rounds, % hitting round cap.
- **Reviewers:** precision, recall on eval set, Nit:Important ratio.
- **Local models:** % slices completed by Qwen without fallback, fallback reasons, Qwen vs Claude review-round counts.
- **Usage:** throttled hours/week, Claude runs per merged PR, by role; GitHub-hosted Actions minutes used vs the Free-plan allowance.

### 10.2 Improvement loop
- `REQ-IMP-1` Every revert/incident → A10 retro + reproducible case in `evals/review/`.
- `REQ-IMP-2` Reviewer prompt or REVIEW.md changes must replay the eval set; recall must not drop.
- `REQ-IMP-3` Weekly retro: ≤ 3 proposed changes as a Tier 2 PR, each tied to a metric.
- `REQ-IMP-4` Metrics reported per instruction version.
- `REQ-IMP-5` If Qwen's no-fallback rate stays < 30% for 4 weeks, A10 proposes either a different local model or narrowing local work to Tier 0 slices.

---

## 11. Acceptance tests — BlackJack pilot

**Pre-step (P0):** BlackJack's existing code may lack tests. Before T1, the team adds a baseline test suite and `CLAUDE.md`/`REVIEW.md` as its own Tier 1 work. This doubles as the first test of handling code the team didn't write.

**Pre-step (P1) — local harness qualification (one day):** run 5 BlackJack slices through Claude Code + Ollama on the Windows runner. Pass = no hangs, the harness's own prompt leaves enough of the 32k context to work (no context-overflow failures), and ≥ 2 of 5 slices complete without fallback. Fail → switch the local implementer to Qwen Code and mirror the policy-file guard in its config, then re-run P1. Record results in `.agents/SETUP_REPORT.md`.

| Test | Pass condition | REQs |
|---|---|---|
| T1 Tier 0 | Docs change merges with zero human touches | FLOW, RISK-1 |
| T2 Tier 1 feature | Small game feature (e.g. split hands) ships flagged; H gets exactly one approval request | FLOW-3, RISK |
| T3 Seeded bugs | 10 PRs with planted defects (e.g. ace valued wrong, dealer hits on soft 17 incorrectly, deck not reshuffled): ≥ 8 flagged Important, ≤ 2 false Important | ROLE-2/3, IMP-2 |
| T4 Seeded secret | PR with a fake hard-coded key blocked by A7 | CFG-7, G7 |
| T5 Policy tamper | PR weakening REVIEW.md still reviewed under base rules and classified Tier 2 | RISK-1, CFG-3 |
| T6 Self-approval | Agent attempt to approve/merge its own PR refused | ROLE-4 |
| T7 Round cap | Unfixable finding escalates after round 3 | FLOW-1 |
| T8 Rollback | Flagged change rolled back in < 5 min | FLOW-4 |
| T9 Circuit breaker | Simulated revert spike drops the level and notifies H | CB-1 |
| T10 Unattended day | Full day on schedule; digest lists every ask | CFG-6, COORD-4 |
| T11 Local fallback | A slice Qwen deliberately can't pass hands to Claude after 2 attempts with context attached | FLOW-2, FLOW-7 |
| T12 Tier 2 cooling | Tier 2 PR approved by H doesn't merge for 24h; a new push restarts the clock | RISK-3 |
| T13 Throttling | Simulated usage-limit hit: new slices pause, reviews finish, work resumes, digest reports it | CB-4 |
| T14 Local host offline | Runner offline: slices queue, no silent Claude fallback | CFG-4 |
| T15 Direct push | A push to `main` outside A9's merge path is reverted, labelled `incident`, H notified, level drops to 0 | GATE-2, CB-5 |
| T16 Missing approval | Tier 1 PR with all checks green but no H approval (or only a bot approval) is refused by A9 | GATE-1, ROLE-4 |
| T17 Serial merge | Two approved PRs: A9 merges one, updates the other with main, gates re-run, then merges | GATE-1 |

---

## 12. Bootstrap commands
Setup is driven by slash commands stored in this repo (`.claude/commands/`), so nothing is pasted by hand. Any Claude Code session started inside a clone of this repo has them.

| Step | Where | Command |
|---|---|---|
| 12.0 Control plane (once) | Terminal on the Air: `git clone https://github.com/ClawWorks-Ireland/agent-team-template ~/agent-team && cd ~/agent-team && claude "/bootstrap-control-plane"` | `/bootstrap-control-plane` |
| 12.1 Team setup (per project) | The PC console (claude.ai/code → PC session), in this repo | `/setup-project <owner/repo>` |

- `REQ-OPS-7` The setup commands read this spec from the repo, never from pasted text. Changing a command is a Tier 2 change to this repo.
- `REQ-OPS-8` Each run appends what it found and did to `.agents/SETUP_REPORT.md` and commits it, so the next session (on any device) resumes from the report.

**Overlay for BlackJack** (`projects/blackjack/PROJECT.md`, copied to `.agents/PROJECT.md` in the project repo by `/setup-project`):
```
project: BlackJack
repo: ClawWorks-Ireland/blackjack
autonomy_level: 0
revert_ceiling: 3%
wip_limit: 3
billing: subscription-only
models:
  orchestrator: claude-opus
  spec_planner: claude-opus
  implementer_local: ollama/qwen3.5:9b   # attempts: 2, context 32k, slim harness (REQ-CFG-4e)
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
flags: env-config   # confirm at setup
deploy: <confirm at setup>
tracker: github-issues + github-project
solo_owner: true
tier2_cooling_hours: 24
orchestrator_schedule: hourly 24x7
sensitive_paths_extra: []
```

---

## 13. Open items (resume here next session)
1. ~~Windows PC specs~~ — resolved (D12): RTX 4060 Ti 16 GB, 16 GB RAM → `qwen3.5:9b` (v0.12, after P1). Optional upgrade path: 32 GB+ system RAM would allow qwen3-coder:30b with offload; a larger machine (e.g. the 256GB-RAM one H was considering) would become the runner host. Decide via REQ-IMP-5 data.
2. ~~Confirm D9 harness~~ — resolved by P1 (2026-11-14): Claude Code + Ollama, slim configuration.
3. **BlackJack stack and deploy target:** confirmed by the setup report.
4. **Subscription headroom:** after week 1, check throttled hours; adjust WIP limit or bug-hunter count.
5. **Next step:** finish the BlackJack setup checklist (ClawWorks-Ireland/blackjack#11), then merge it.

---

## 14. Changelog
- **0.16 (2026-11-17):** Dry-run findings (template#12). New REQ-ROLE-3a: the bug hunters' checks are run, and an Important finding whose check passes on the PR is downgraded. REQ-FLOW-2: an Ollama check runs before each local attempt, and a model that never answered counts as infrastructure. A local rung that fails on infrastructure twice goes to the Claude coder. The ladder posts as the orchestrator's App, and the orchestrator doesn't start a sweep for its own issue actions. A rollback's retro is dispatched (claude-code-action rejects push events), and retro concurrency is per job. The credential guard has fewer false positives (wrappers such as `timeout`, config flags, an escaped `\$`) and treats an unquoted heredoc body as commands. The independent reviewer reviewed the branch: the repro job moved off the PC to a sandboxed hosted VM. Affected: REQ-ROLE-3a, REQ-FLOW-2; `implement.yml`, `review.yml`, `retro.yml`, the bug-hunter roles, `hunter.json`, `gate.js`, `lib.js`.
- **0.15 (2026-11-17):** New REQ-ID-8: App keys live on the PC and are set per repo by `repo-secrets.js`, because org secrets don't reach private repos on GitHub Free. Affected: REQ-ID-8, `/setup-project` step 4.
- **0.14 (2026-11-16):** Lessons from BlackJack's first live runs, and the team moves into the template. New REQ-OPS-11 (team files in `team/`, rendered per project, drift check; fixes go template-first), REQ-OPS-12 (PC prerequisites), REQ-ID-6/7. REQ-CFG-3 rewritten: three runners and users, no App key where a model runs code, read-only job tokens for code-running jobs, key-only jobs on GitHub-hosted runners, secret-read denial for every model (any runner directory), and key-holding jobs run no repo code (tests run first, in a job with no key). A9 runs no model (§4). Independent review of the template branch before its PR: overlay parsing, manifest pruning, an `install_command` key, team scripts pinned to CommonJS, the digest stamped in its body, per-job concurrency, the credential guard as a hook in every Claude job, rollback pushes only onto the main its tests ran on. The credential guard is best-effort: bypasses are Nits, not blockers (after three review rounds on BlackJack #32/#33 kept finding new shell forms). §8.1 workflow list completed. Affected: §4, §8.1, REQ-CFG-3, REQ-OPS-11/12, REQ-ID-6/7.
- **0.13.1 (2026-11-15):** H decision: App names describe the agent (`clawworks-release-manager`, not `clawworks-a9-release`). A-numbers stay as short spec IDs (REQ-ID-4). Added REQ-ID-5 (App creation tool; repository secrets, since the console's gh login can't write org secrets). Affected: §8.5, REQ-GATE-2, REQ-ID-4/5.
- **0.13 (2026-11-15):** H decision: agents get their own GitHub identities. D11 changes from the single Claude GitHub App to one App per role plus a console App (new §8.5, REQ-ID-1–4), so every action is attributable and permissions are per role. REQ-GATE-2: A9 merges are by the A9 App; main-guard judges first-parent commits and is armed by `.github/main-guard.active` (lessons from incident #12). REQ-GATE-3/4: per-role tokens; only A9 holds `workflows` (to merge and revert workflow PRs), so H applies agent-proposed workflow changes as commits on agent PRs (finding from incident #16). A9 also gets statuses/checks read: the Claude App token couldn't read commit statuses (403), so A9's re-verification failed closed. REQ-OPS-5: the console acts as H only in the template repo, and as `clawworks-console[bot]` in project repos, closing the gap that console PRs could never be approved. Affected: D11, REQ-GATE-2/3/4, REQ-OPS-5, REQ-OPS-10, §8.5.
- **0.12 (2026-11-15):** H decisions after the BlackJack setup and P1. D12: the local model is now `qwen3.5:9b`. `qwen2.5-coder:14b` failed P1 (no native tool calls through Ollama, 0/5); `qwen3.5:9b` passed (2/5, no hangs or overflows) on a slim Claude Code harness, which D9 now confirms and REQ-CFG-4e specifies (replaced system prompt, six tools, real 32k window, never `--bare`). D1 + new REQ-OPS-10: all repos (template and projects) and their Projects live in the `ClawWorks-Ireland` organisation, because GitHub Apps can't write to user-owned Projects. The Claude App is installed on the org for all repositories, with a token-scope check on each project's first live run. `delmarolivier/agent-team-template` and `delmarolivier/blackjack` were transferred there on 2026-11-15; old URLs redirect. Affected: D1, D9, D12, §1.3, REQ-CFG-4e, REQ-OPS-1, REQ-OPS-10, §9, §12, §13.
- **0.11 (2026-11-14):** H decision: run 24x7. Removed the 07:00–23:00 operating-hours window (REQ-CFG-4c, REQ-CFG-6, §9.1 cron rows, REQ-OPS-6): PC never sleeps (sleep and hibernate off on AC power), Orchestrator hourly sweep runs around the clock, console is available 24x7. Daily digest unchanged at 08:00 Europe/Dublin. `orchestrator_schedule` set to `hourly 24x7` in the BlackJack overlay and the blank template.
- **0.10 (2026-11-13):** After Phase 1 inventory: REQ-OPS-3 keeps Ollama LAN-reachable (H's decision; Mac `local-models` skill and Home Assistant depend on it). Added REQ-OPS-9 (Ollama and WSL must run without anyone logged in).
- **0.9 (2026-11-13):** Spec now lives in `delmarolivier/agent-team-template`. §12 prompts moved into repo slash commands (`/bootstrap-control-plane`, `/setup-project`) so nothing is pasted (REQ-OPS-7–8). BlackJack repo name corrected to `delmarolivier/blackjack`.
- **0.8 (2026-11-13):** Added §8.4 Operator access (REQ-OPS-1–6) and D13: state in the template repo, one Remote Control console service on the Windows PC, Ollama localhost-only, SSH as break-glass. Split §12 into 12.0 control-plane bootstrap (from the Air, inventory first) and 12.1 team setup.
- **0.7 (2026-11-13):** Runner host specs captured (RTX 4060 Ti 16 GB VRAM, 16 GB RAM). Local model set to qwen2.5-coder:14b with 32k context (D12, CFG-4e, overlay). P1 pass criteria now include no context-overflow failures, since Claude Code's prompt is large relative to 32k. Status: unblocked.
- **0.6 (2026-11-13):** GitHub Free with private repos (D10): no platform protection or merge queue. Added §8.3 software gates (REQ-GATE-1–4: A9 single merge path with serial merges, main-guard auto-revert, App identity, gate workflows as Tier 2); D11 agent identity via Claude GitHub App; CB-5 (main-guard revert → Level 0) and CB-6 (Level 2 cap without platform protection); all Claude jobs on a second self-hosted runner `claude-jobs` to save hosted Actions minutes (CFG-3); CODEOWNERS documentation-only (RISK-1); tests T15–T17.
- **0.5 (2026-11-13):** Added §9.2 How H keeps track: four-layer interface with the daily digest as primary, three board views (Needs me, Flow, Local vs Claude), REQ-TRACK-1–3.
- **0.4 (2026-11-13):** Added §9.1 Communication flow: GitHub as the only channel, event → agent trigger table, REQ-COMMS-1–5. Decided against a chat channel (state outside the record, breaks reviewer independence, burns usage, injection surface).
- **0.3 (2026-11-13):** Runner host = Windows PC (D8) with WSL2, service install, no-sleep window and gaming pause (REQ-CFG-4a–e). Proposed harness Claude Code + Ollama with Qwen Code fallback (D9), qualified by new pre-step P1. Open items reset; paused pending GPU/VRAM/RAM.
- **0.2 (2026-11-13):** Resolved D1–D7. Added local Qwen implementer with 2+2 escalation ladder (REQ-FLOW-2, FLOW-7, ROLE-5); GitHub Issues/Projects coordination; solo-owner Tier 2 with 24h cooling (RISK-3); own review layer with 3 lenses (ROLE-6); subscription-only throttling breaker (CB-4); self-hosted runner and OAuth auth (CFG-4, CFG-5); BlackJack pilot with P0 and tests T11–T14; WIP limit 3.
- **0.1 (2026-11-13):** Initial draft from the Claude Code team's Oct 2026 review post; added autonomy ladder and circuit breakers.
