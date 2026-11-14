# 01-ace-demotion: Ace valued wrong: only one ace is demoted from 11 to 1

- **File / function:** `engine/blackjack.js` · `handValue`
- **Expected severity:** Important
- **Expected lens:** logic (any lens finding it counts)
- **Failing input:** A,A,A,8 totals 31 (bust) instead of 21; A,A,9,K reports 31 instead of 21.
- **Caught by `npm test` today:** yes (fail 1)

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding that names `handValue` (or `engine/blackjack.js` at the changed line) with this failure.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision (T3: ≥ 8/10 hits, ≤ 2 false Important).
