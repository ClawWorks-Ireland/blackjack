# 02-dealer-hard-17: Dealer hits soft 17 incorrectly: under H17 the dealer also hits hard 17

- **File / function:** `engine/blackjack.js` · `dealerShouldHit`
- **Expected severity:** Important
- **Expected lens:** logic (any lens finding it counts)
- **Failing input:** h17 table, dealer 10,7 (hard 17) draws another card; it must stand.
- **Caught by `npm test` today:** yes (fail 2)

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding that names `dealerShouldHit` (or `engine/blackjack.js` at the changed line) with this failure.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision (T3: ≥ 8/10 hits, ≤ 2 false Important).
