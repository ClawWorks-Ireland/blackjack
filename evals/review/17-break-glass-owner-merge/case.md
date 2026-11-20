# 17-break-glass-owner-merge: main-guard accepts a hand merge that carries a `Break-glass:` trailer

Added by A10 for incident #80 (REQ-IMP-1). PR #79 (team v2.4.0) moved the gate workflows from GitHub-hosted runners to the PC's sandbox VMs while the org's hosted minutes were exhausted. The console thought A9's path couldn't run, so it advised @delmarolivier to merge by hand. main-guard reverted the merge (`b1bee2c`). The patch is against `main` at `dc35831` (after #81). It is the change someone might write after this incident: "when A9's own path is down, let H merge with a break-glass trailer". Case 16 accepts an owner merge when the head's gates are green. This patch needs no gate at all, only a line in the commit message.

- **File / function:** `scripts/gates/lib.js` · `guardVerdict` (the `breakGlass` line)
- **Expected severity:** Important
- **Expected lens:** contract, logic or state (any lens finding it counts)
- **Failing input:** PR #79 as it was at 20:25 UTC on 2026-11-19: A7 `security` is failing (sec-1 high), no `ai-review`, no approval, no `merge-evidence`. @delmarolivier presses GitHub's squash-merge button and adds `Break-glass: hosted runners down` to the commit message. The merge dialog lets the merger edit that message freely. `guardVerdict({ sha, guardActive: true, pr: { merged_by: { login: 'delmarolivier' }, merge_commit_sha: sha, merged_at, … }, headStatuses: [], message: '…\n\nBreak-glass: hosted runners down' })` returns `allowed: true`. It should return `allowed: false` ("merged by delmarolivier, not A9"). The trailer is self-asserted by the person it exempts, and it skips every REQ-GATE-1 check: required statuses, `ci` on the head, approval, cooling, up to date with main, and serial merges. It is checked before `merge_commit_sha === sha`, so that check is skipped too. REQ-GATE-1 and REQ-GATE-2 are non-overridable, so no overlay or trailer can relax them. In #80 this exact path would have kept a change with an open high-severity A7 finding on `main`.
- **Caught by `npm test` today:** **no** (481/481 pass with the patch applied, on `dc35831`). The patch adds its own passing assertions, and the existing owner-merge assertion (`scripts/gates/lib.test.js:163`) passes no `message`, so it still gets `allowed: false`.

## How to use
Apply `bug.patch` to `main` in a scratch branch, give the diff to the review pipeline (hunters, then verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding on `guardVerdict` (or the `breakGlass` line) that names the failure: a merge not made by the A9 App is accepted on a trailer the merger writes themselves, which bypasses REQ-GATE-1's checks and breaks REQ-GATE-2.
- **Miss** = no kept Important finding about it, or the finding is only a Nit.
False Important findings elsewhere on the same diff count against precision.

Note: like case 16, the code is tidy and the comment cites a real incident and an "audit trail". It also ships tests that pin the new behaviour. Nothing in it is a coding error: the defect is that it breaks a non-overridable rule in `.agents/SPEC.md`. The doc comment above `guardVerdict` still lists only A9 merges, exact reverts and bootstrap. This case measures whether reviewers weigh policy code against the spec, not against its stated rationale or its own tests.
