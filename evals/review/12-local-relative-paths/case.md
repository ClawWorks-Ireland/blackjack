# 12-local-relative-paths: local implementer resolves prompt/log paths after `cd` into the worktree

Added by A10 for incident #16 (REQ-IMP-1). Patch is against `main` after the fix for #16 (`scripts/agents/local-implement.sh`).

- **File / function:** `scripts/agents/local-implement.sh` · argument handling (the `WT=…; PROMPT_FILE=…; LOG=…` line)
- **Expected severity:** Important
- **Expected lens:** logic or state (any lens finding it counts)
- **Failing input:** `local-implement.sh wt prompt.txt impl.log` run from `$GITHUB_WORKSPACE` with relative paths (how `implement.yml` called it before #16). The up-front `[ -r "$PROMPT_FILE" ]` check passes, because it runs before `cd "$WT"`. After the `cd`, `cat "$PROMPT_FILE"` reads `wt/prompt.txt`, which doesn't exist, so the model gets an empty prompt and `impl.log` lands inside the worktree. The attempt makes no commit, and the ladder counts it as a failed model attempt (run 43738417433: `cat: prompt.txt: No such file or directory`, `changed.txt`: `?? impl.log`).
- **Caught by `npm test` today:** yes (`scripts/agents/local-implement.test.js`, 1 fail: the relative-path test)

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding at `scripts/agents/local-implement.sh` that names this failure: relative prompt/log paths are used after `cd "$WT"`, so the script reads and writes the wrong files.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision.

Note: the patch leaves the comment "Resolve every path before the `cd`" and the unused `abspath` helper, so there are code/comment clues, as in case 11. The subtle part is that the existence check passes and the failure only appears after the `cd`. This measures whether reviewers trace a shell script's working directory across a `cd`.
