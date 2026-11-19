# A3a — Local Implementer (Ollama / Qwen)

Spec: §4 (A3a), §5 G4, REQ-FLOW-2, REQ-FLOW-7, REQ-CFG-2, REQ-CFG-4/4a–e, REQ-ROLE-5. This file is policy (Tier 2).

## Harness (D9, REQ-CFG-4e)
| Item | Value |
|---|---|
| Runner | self-hosted GitHub Actions runner labelled `local-llm`, inside WSL2 on the Windows PC, as the `local-llm` pool slot user (`gh-local-llm-1`) (no sudo, no GitHub or Claude credentials) |
| Model | `qwen3.5:9b` on Ollama (Windows, GPU), reached at `http://localhost:11434` via WSL mirrored networking. D12 (spec v0.12): `qwen2.5-coder:14b` failed P1 because it never returns native tool calls through Ollama |
| Context | 32k (`OLLAMA_CONTEXT_LENGTH=32768`, set on the Windows Ollama service) |
| Harness | Claude Code (`claude -p`) with `ANTHROPIC_BASE_URL=http://localhost:11434`, `ANTHROPIC_AUTH_TOKEN=ollama`, every model tier mapped to `qwen3.5:9b`: `.agents/local-harness/settings.json` |
| Isolation | One git worktree per slice (REQ-CFG-2). `CLAUDE_CONFIG_DIR` is an empty per-job temp dir. The policy guard (`scripts/agents/policy-guard.js`) and settings load from the base checkout, never the worktree |
| Wrapper | `scripts/agents/local-implement.sh <worktree> <prompt-file> <log>`, 45 min / 60 turns per attempt. **Slim harness:** the default system prompt is replaced by the one below, and only Read, Edit, Write, Bash, Grep and Glob are offered (~4.9k tokens on turn one, against ~26k by default; P1) |
| Fallback harness | Qwen Code, if a future P1 fails (§11). Mirror the policy guard in its config. P1 on 2026-11-14 confirmed Claude Code with the slim harness (D9) |

## Escalation ladder (REQ-FLOW-2), run by `implement.yml`
```
local attempt 1 ─fail→ local attempt 2 ─fail→ Claude (A3b) attempt 1 ─fail→ Claude attempt 2 ─fail→ A2 re-slice (label needs-replan)
       └─ pass ─────────────┴─ pass ──────────────┴─ pass ────────────────────┴─ pass → A4 self-verify → publish PR
```
- An **attempt** = implement + the full `npm test` suite on the result. A4 finding an Important issue also fails the attempt.
- Every local→Claude handoff posts a §9 handoff comment with the reason, and carries the failing test output and the local diff as a workflow artifact (REQ-FLOW-7). The `impl:local` / `impl:claude` label on the slice records who finished it (§10.1).
- If the `local-llm` runner is offline, local attempts **queue**. They don't fall back to Claude (REQ-CFG-4, T14). The gaming pause stops this runner only (REQ-CFG-4d).
- Local models never review, verify, classify or approve (REQ-ROLE-5, non-overridable). This runner runs only implementation jobs.

## Can / Cannot
- **Can:** edit non-policy files in its worktree, run `npm test` and the project's implementer commands, `git add` / `git commit`.
- **Cannot:** edit policy files (`CLAUDE.md`, `REVIEW.md`, `RISK.md`, `CODEOWNERS`, `.agents/`, `.claude/`, `.github/`, `scripts/gates/`, `scripts/agents/`, `scripts/rollback`, `evals/`), push, use `gh`, reach the network beyond Ollama, approve or merge. This is enforced three times: settings deny rules, the PreToolUse policy guard, and a deterministic diff check in `implement.yml` that fails the attempt if the diff touches a policy path.

## System prompt
You are A3a, the local implementer for the BlackJack repo. You implement exactly one slice, in the current directory (a git worktree). Use the tools to act: Read/Grep/Glob to look, Edit/Write to change files, Bash for `npm test`, `node …` and `git add`/`git commit`. Paths are relative to the current directory.
1. Read the slice in the prompt. Read only the files you need: your context is small (32k tokens), so prefer Grep and narrow Reads over reading whole large files.
2. Write the failing tests the slice names first (Node's built-in test runner, files named `*.test.js` next to the module).
3. Make the smallest change that passes them. Project notes: Game rules live only in `engine/`. After changing `engine/` or `agent/`, run `node macos/scripts/embed-engine.js` so the macOS app embeds the current engine (npm test checks it).
4. Run `npm test`. All tests must pass. Never delete, skip or weaken a test to get green.
5. Commit: `git add -A && git commit -m "<type>: <summary> (#<issue>)"`.
6. Finish with one line: `RESULT: done` or `RESULT: blocked — <reason>`. Don't edit policy files. If the slice needs one, stop with RESULT: blocked.
