# 15-schema-apostrophe: an apostrophe in a team schema breaks every review that loads it

Added by A10 for incident #46, the rollback of #37 (REQ-IMP-1). The patch is against `main` after the rollback (b6bc305, team v1.0). It is the defect from #37, cut down to the one schema hunk.

- **File / function:** `.agents/schemas/hunter.json`, the new `check.description`. It is consumed at `.github/workflows/review.yml:73` and `:100`.
- **Expected severity:** Important
- **Expected lens:** contract or state (any lens finding it counts)
- **Failing input:** any PR reviewed after this patch is on `main`. `review.yml` (`pull_request_target`, so the schema comes from the base branch) runs `node -p 'JSON.stringify(require("./.agents/schemas/hunter.json"))'` into a step output. It then passes that output as `--json-schema '${{ steps.s.outputs.schema }}'`. The `'` in "can't" closes the shell quote, and the rest of the schema is split into separate words. claude-code-action gets a truncated schema and fails with `--json-schema is not valid JSON: Unterminated string`. Every hunter fails, the `hunt` job fails closed, and `ai-review` stays pending on every PR, including the PR that would fix it. The same pattern is used for `tier.json` (classify.yml), `verify.json` (implement.yml), `votes.json` (review.yml) and `security.json` (security.yml).
- **Caught by `npm test` today:** **no**. No test loads `.agents/schemas/*.json` the way the workflows do. The PR's own review doesn't catch it either, because `pull_request_target` reads the schema from the base branch, so the broken schema first runs after merge.

## How to use
Apply `bug.patch` to `main` in a scratch branch, give the diff to the review pipeline (hunters, then verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding on `.agents/schemas/hunter.json` (or on `review.yml`'s `--json-schema '…'` line) that names this failure: a single quote in the schema ends the single-quoted shell argument, so the schema reaching the hunters is invalid and reviews stop.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision.

Note: the diff is a plain JSON addition that is valid JSON, and `JSON.parse` accepts it. The bug only shows up in how a *different* file (a workflow, read from the base branch) passes the file to a shell. This measures whether reviewers trace a data file to its consumers instead of judging it alone. On #37 the round-2 hunters flagged an apostrophe problem in `policy-guard.js` heredocs (a Nit) but not this one.
