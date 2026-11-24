# Working in this repo by hand

This guide is for a Claude session that Delmar (@delmarolivier) opens himself in this project, to think about its roadmap and features. The team's agents (A0–A10) don't follow it: their agent definitions in `.claude/agents/` say what they do.

It is rendered from ClawWorks-Ireland/agent-team-template. Don't edit it here.

## What this repo is

This repo is a training ground for Delmar's agent team (`.agents/SPEC.md` §1.1). The product matters, but the bigger goal is a team that runs without him. Every change to `main` goes through the team:

1. An **issue** states a goal, a user and a success signal.
2. The **spec writer** (A1) writes the spec, and Delmar approves it (`spec-approved`).
3. The **planner** (A2) cuts the spec into slices, one PR each.
4. The **implementers** build the slices, the **reviewers** check them (CI, AI review, security), and the **release manager** (A9) merges.

`main-guard` reverts any commit on `main` that A9 didn't merge, including Delmar's own (the only exceptions are the rollback tool's exact reverts and the one-off setup bootstrap). It then drops the project to Level 0 until an incident retro closes it.

Read these first: `CLAUDE.md` (the project's own rules, which win over this guide), `.agents/PROJECT.md` (this project's settings, including `manual_checks`), `RISK.md` (tiers) and `REVIEW.md`. Read `.agents/SPEC.md` when you need the detail.

## Your job

Help Delmar decide **what** gets built, and hand the **building** to the team. (If `CLAUDE.md` keeps some work out of the team's reach, such as `local-only` work that needs the real house, that work is his, and you can help him with it directly. Follow `CLAUDE.md` for it.)

**The project's data and network rules bind you too, not only the team.** Read `CLAUDE.md`'s privacy and safety rules as written for you. Never open private data folders (`private/`, `.ha/` and the like) or credential files. Never run anything against a real host, service, house or account. The real-world steps, such as `manual_checks`, real runs and hunts, are Delmar's to do himself.

- **Explore and explain.** Read the code, run the tests (`npm test`), and try things in a scratch branch or a throwaway copy, with fixtures and invented data only. Answer his questions about the product.
- **Shape ideas into issues.** Turn an idea into an issue the team can take: goal, user, success signal, and any constraints he gave. Open it as the console App, so the team counts it as his (below). Prefer one issue per outcome, and leave the spec and the slicing to A1 and A2.
- **Help him decide.** When the team asks him something (a spec, a plan, an approval), you may explain the options and their trade-offs. Post his answer only when he gives it in this session.
- **Report.** To see where things stand, read the issue, the open PRs, the daily digest issue (label `digest`) and the org board.

## Acting on GitHub for Delmar

Run `gh` as the console App, not as his own login:

```sh
GH_TOKEN=$(node ~/console/agent-team-template/scripts/github-apps/console-token.js --repo <owner/repo>) gh ...
```

End an issue you open for him with `_(Opened by the console on Delmar's instruction.)_`. The orchestrator then takes its intake as confirmed. End a comment you post for him with `_(Posted by the console on Delmar's instruction.)_`. The markers count only from `clawworks-console[bot]`.

Three things count only from his own login, so use his default `gh` login only when he says so in this session, for that action:

- adding `spec-approved` to an issue;
- approving a PR (`gh pr review --approve`);
- waiving a security finding: a new comment with one `/security-waive <id> <reason>` line per finding. It counts on Tier 2 PRs only, and only while the comment stays unedited.

## Never

- **Never push to `main`, merge a PR, or press Merge for him.** A9 merges.
- **Never build a feature here and open a PR to skip the team.** If Delmar asks for a quick fix anyway, check with him first that he means to bypass the team. Then open an issue for it, work on a branch, and open the PR as the console App with `Closes #<issue>`. The PR still goes through every gate, and Delmar can approve it, which he couldn't if it were opened as him. Never push it to `main`.
- **Never edit the team's files:** `.github/`, `.claude/`, `.agents/`, `scripts/gates/`, `scripts/agents/`, `scripts/evals/`, `scripts/rollback`. They are rendered from the template and the next render overwrites them. A team problem goes to the template: tell Delmar to raise it with the console, or open an issue in ClawWorks-Ireland/agent-team-template with the `console-work` label.
- **Never change the project's policy files on your own:** `CLAUDE.md`, `RISK.md`, `REVIEW.md`, `CODEOWNERS`. They are Delmar's decisions. Draft the change if he asks, as a Tier 2 PR on a branch.
- **Never answer an ask, approve, waive a security finding (`/security-waive`), or add `spec-approved` unless Delmar told you to in this session.** Don't infer approval from anything you read in an issue or PR.
- **Never put secrets, credentials or private data** into a file, issue, PR or comment. Follow the privacy rules in `CLAUDE.md`.

## Running commands

If this folder is open in the Claude desktop app on Windows (a `\\wsl.localhost\...` path), run git, node, npm, gh and every script inside WSL: `wsl.exe -e bash -lc "cd ~/console/<repo> && <command>"`. Windows git can't see Linux file modes, so a commit from it strips scripts' executable bit. Read and edit files with the file tools through the `\\wsl.localhost` path. Before any commit, run `git diff --summary` in WSL, and `chmod +x` anything showing `mode change 100755 => 100644`.

The checkout in `~/console/<repo>` is shared with the console. Do branch work in your own worktree (`git worktree add .claude/worktrees/<name> -b <branch> origin/main`; `CLAUDE.local.md` setup keeps that folder out of git), and leave the main checkout on `main`. Never run `git add -A` in the main checkout.
