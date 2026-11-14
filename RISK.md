# RISK.md — tier path rules (spec §6, REQ-RISK-1)

This file is authoritative for the **tier floor** of a PR. `scripts/gates/risk.js` parses the block below, and `tier-approval.yml` and A8 (Risk Classifier) both use it. It is always read from the **base branch**: a PR that edits this file is judged by the rules already on `main`, and the edit itself is Tier 2.

How it works:
- Each changed file takes the tier of the **last** rule that matches it (like `.gitignore`). Files that match no rule are **Tier 1**.
- A PR's floor is the highest tier among its files. A deleted or renamed file counts at its old path and at its new path.
- A8 may **raise** a PR above the floor (e.g. a behaviour change hidden in a "docs" PR). It may never lower it. The gate takes `max(floor, A8 label)`.
- No feature flags exist (overlay `flags: none`), so behaviour changes are at least Tier 1 (REQ-FLOW-3). That's why the default is 1.

Globs: `*` matches within one path segment, `**` matches any number of segments, `?` one character.

```risk-rules
# tier  glob
# --- Tier 0: docs, tests, QA records (no behaviour change)
0 **/*.md
0 docs/**
0 **/*.test.js
0 macos/Tests/**
0 qa/reports/**
0 qa/handoff-history/**
0 qa/state.json
0 agent/LEADERBOARD.md
0 agent/leaderboard.json
0 agent/fixtures/**

# --- Tier 2: agent policy, gates, CI/CD, build, dependencies, network-facing server
2 .github/**
2 .claude/**
2 .agents/**
2 CLAUDE.md
2 REVIEW.md
2 RISK.md
2 CODEOWNERS
2 scripts/**
2 package.json
2 package-lock.json
2 qa/package.json
2 qa/package-lock.json
2 macos/scripts/**
2 macos/Package.swift
2 .mcp.json
2 server/**
2 evals/review/**
2 .gitignore
2 qa/.gitignore
```

## Why these are Tier 2
| Path | Reason |
|---|---|
| `.github/`, `scripts/` | CI/CD and the software gates themselves (REQ-GATE-4), plus rollback |
| `.claude/`, `.agents/`, `CLAUDE.md`, `REVIEW.md`, `RISK.md`, `CODEOWNERS` | Agent policy files (§1.3) |
| `package.json`, lockfiles, `macos/Package.swift`, `macos/scripts/` | Build and dependencies. `npm test` is the `ci` gate, so changing it changes the gate |
| `server/` | The live table server is network-facing. It must never be exposed publicly or deployed without Delmar (CLAUDE.md) |
| `.mcp.json` | Changes what an MCP client launches |
| `evals/review/` | The reviewer eval set (REQ-IMP-2): removing a case would hide a recall drop |
| `.gitignore` | Could start committing `server/data/` (player data) or local config |

Everything else (`engine/`, `agent/`, `web/`, `macos/Sources/`, `qa/*.js`, `index.html`) is Tier 1 by default.
