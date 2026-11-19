# 16-owner-merge-allowed: main-guard lets the owner's own merges through

Added by A10 for incident #66: PR #65 was merged by hand by @delmarolivier and main-guard reverted it (REQ-IMP-1). The patch is against `main` after the revert (efc1bb0). It is the change someone might write after this incident ("the merge button is always there, so accept H's merge when the gates are green"). It weakens the control that caught #66.

- **File / function:** `scripts/gates/lib.js` · `guardVerdict`
- **Expected severity:** Important
- **Expected lens:** contract or logic (any lens finding it counts)
- **Failing input:** PR X is Tier 1 with `ai-review`, `security` and `tier-approval` green, and A9 has written `merge-evidence` on its head. A9 then merges PR Y first, so X is behind `main` and A9 would `update-branch` and re-run the gates before merging X (REQ-GATE-1). Before that happens, @delmarolivier presses GitHub's merge button on X. `guardVerdict({ sha, guardActive: true, pr: { merged_by: { login: 'delmarolivier' }, merge_commit_sha: sha, … }, headStatuses: [ai-review, security, tier-approval, merge-evidence all success by github-actions[bot]] })` returns `allowed: true` ("owner merge"). It should return `allowed: false` ("merged by delmarolivier, not A9"). The result is that main gets X+Y, a combination no gate ever tested. Other checks are skipped too: the `ci` check-run on the head, `tier2-cooling` (not in `REQUIRED_STATUSES`), serial merges, and the REQ-GATE-2 rule that only the A9 App merges. That rule is non-overridable, so no overlay can relax it.
- **Caught by `npm test` today:** **no** (465/465 pass with the patch applied). The existing owner-merge assertion (`scripts/gates/lib.test.js:163`) gives only `merge-evidence`, not the three required statuses, so it still gets `allowed: false`.

## How to use
Apply `bug.patch` to `main` in a scratch branch, give the diff to the review pipeline (hunters, then verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding on `guardVerdict` (or the `ownerMerge` line) that names this failure: a merge by someone other than the A9 App is accepted, which bypasses REQ-GATE-1's merge-time checks (up to date with main, ci on head, cooling) and breaks REQ-GATE-2.
- **Miss** = no kept Important finding about it, or the finding is only a Nit.
False Important findings elsewhere on the same diff count against precision.

Note: the patch comes with a reasonable-sounding comment, and the code is tidy. Nothing in it is a coding error. The defect is that it breaks a non-overridable rule in `.agents/SPEC.md`, and the doc comment above `guardVerdict` ("an A9 squash merge: … merged by MERGE_BOT") still says the old rule. This case measures whether reviewers check policy code against the spec instead of trusting its stated intent.
