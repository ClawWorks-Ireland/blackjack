# 05-double-soft: Restricted doubling allows soft totals

- **File / function:** `engine/blackjack.js` · `canDoubleOn`
- **Expected severity:** Important
- **Expected lens:** logic (any lens finding it counts)
- **Failing input:** doubleOn '9-11': A,9 (soft 20, hard value 10) is allowed to double; only hard 9-11 may.
- **Caught by `npm test` today:** yes (fail 1)

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding that names `canDoubleOn` (or `engine/blackjack.js` at the changed line) with this failure.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision (T3: ≥ 8/10 hits, ≤ 2 false Important).
