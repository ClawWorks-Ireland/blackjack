# 13-throttle-whole-log: usage-limit detection scans the whole execution log, not the final result

Added by A10 for incidents #21 (part 2) and #20 (REQ-IMP-1). Patch is against `main` after the fix for #21 (`scripts/gates/lib.js`).

- **File / function:** `scripts/gates/lib.js` · `isUsageLimited` (and `USAGE_LIMIT_RE`)
- **Expected severity:** Important
- **Expected lens:** logic or contract (any lens finding it counts)
- **Failing input:** a Claude execution file whose final `result` is an error for some other reason (`error_max_turns`, a `gh` failure), with Claude Code's normal `{"type":"rate_limit_event", …}` message earlier in the stream, which every run has. With the patch, `said` is the whole file and the regex matches `rate_limit`, so `throttle-check` opens a `throttled` issue and REQ-CB-4a stops all new slices. That is what happened in #18 (run 43739729441, opened 2026-11-15T17:13Z, closed by Delmar as a false positive at 19:41Z). It also matches limit text that Claude only *quoted* in an assistant message.
- **Caught by `npm test` today:** yes (`scripts/gates/lib.test.js`, "CB-4 usage-limit detection: no false positives")

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding at `scripts/gates/lib.js` `isUsageLimited` that names this failure: the check now scans every message (or `rate_limit` matches the stream's `rate_limit_event`), so a run that failed for another reason, or that only mentions a limit, opens a false `throttled` issue.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision.

Note: the patch adds a plausible comment ("the limit text can be in any message") that argues *for* the bug, and the doc comment above `USAGE_LIMIT_RE` still says the opposite. Reviewers need to know that `rate_limit_event` is in every stream-json run, which only the doc comment and the tests say. This measures whether reviewers weigh a detector's false positives, not only its recall.
