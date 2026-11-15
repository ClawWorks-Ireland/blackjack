# 11-guard-second-parent: main-guard judges commits that arrived through a merge's second parent

Added by A10 for incident #12 (REQ-IMP-1). Patch is against `main` after the fix for #12 (`guardCommits` in `scripts/gates/lib.js`).

- **File / function:** `scripts/gates/lib.js` · `guardCommits`
- **Expected severity:** Important
- **Expected lens:** logic or state (any lens finding it counts)
- **Failing input:** a branch of 3 commits that already contain `.github/workflows/main-guard.yml`, merged into `main` with `git merge --no-ff` and pushed. `guardCommits(git, { before, after })` returns the 3 branch commits plus the merge, instead of only the merge. Each branch commit has no PR whose `merge_commit_sha` is that commit, so `guardVerdict` calls it a "direct push" and main-guard reverts a legitimate merge (what happened to PR #11). Sweep mode (`since`) has the same defect.
- **Caught by `npm test` today:** yes (`scripts/gates/guard-commits.test.js`, fail 2)

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding that names `guardCommits` (or `scripts/gates/lib.js` at the changed line) with this failure: dropping `--first-parent` makes main-guard judge second-parent commits.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision.

Note: the patch leaves the doc comment saying "first-parent", so the code/comment mismatch is a fair clue. This is the first gate (not engine) case: it measures whether reviewers reason about git history semantics on policy code.
