# 14-ladder-drops-handoff: local attempt 2 gets the inherited hand-off instead of attempt 1's work

Added by A10 for incident #21 (part 1) (REQ-IMP-1). Patch is against `main` after the fix for #21 (`scripts/gates/lib.js`).

- **File / function:** `scripts/gates/lib.js` · `nextRung`, the `local && attempt < 2` branch
- **Expected severity:** Important
- **Expected lens:** logic or contract (any lens finding it counts)
- **Failing input:** `nextRung('local', 1, { job: 'success', retry: 0, run: '43753799564', handoffRun: '' })`, i.e. local attempt 1 on #15 that ran ~45 min, hit `LOCAL_TIMEOUT_MIN` and made no commit. With the patch it returns `handoffRun: ''`, so the ladder dispatches local attempt 2 with no `handoff_run`, and attempt 1's saved `slice.patch` and `test.log` are never read. That breaks REQ-FLOW-7 and is the behaviour #21 reported before the fix (`implement.yml` only computed a hand-off for local→Claude).
- **Caught by `npm test` today:** yes (`scripts/gates/lib.test.js`, "T11 ladder: … each rung gets the previous attempt")

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding at `scripts/gates/lib.js` `nextRung` that names this failure: local→local passes the inherited hand-off (empty on attempt 1), not this run's id, so the second local attempt loses the first attempt's work.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision.

Note: a one-word change (`run` → `inherited`) next to an infra-retry branch that legitimately uses `inherited`, so it looks consistent. The doc comment above `nextRung` says every next rung gets THIS attempt's files. This measures whether reviewers check each branch of a small decision table against its documented contract.
