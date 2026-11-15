# 04-split-21-blackjack: A two-card 21 after a split is paid as a blackjack

- **File / function:** `engine/blackjack.js` · `settle`
- **Expected severity:** Important
- **Expected lens:** rules (any lens finding it counts)
- **Failing input:** Split 8s, one hand gets A-K... rather A,K on a split ace hand: paid 3:2 (net 1.5×bet) instead of an ordinary 21 (net 1×bet, or push vs dealer 21).
- **Caught by `npm test` today:** yes (fail 4)

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding that names `settle` (or `engine/blackjack.js` at the changed line) with this failure.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision (T3: ≥ 8/10 hits, ≤ 2 false Important).
