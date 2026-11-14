# 10-qka-straight: 21+3: Q-K-A no longer counts as a straight

- **File / function:** `engine/sidebets.js` · `sidebets.isStraight`
- **Expected severity:** Important
- **Expected lens:** logic (any lens finding it counts)
- **Failing input:** Player Q♠ K♥, dealer A♦: 21+3 should pay 10:1 (straight); pays nothing.
- **Caught by `npm test` today:** yes (fail 3)

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding that names `sidebets.isStraight` (or `engine/sidebets.js` at the changed line) with this failure.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision (T3: ≥ 8/10 hits, ≤ 2 false Important).
