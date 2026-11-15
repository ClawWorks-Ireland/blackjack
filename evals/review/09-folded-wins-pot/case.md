# 09-folded-wins-pot: Poker: a folded seat stays eligible for pots

- **File / function:** `engine/poker.js` · `Table.pots`
- **Expected severity:** Important
- **Expected lens:** state (any lens finding it counts)
- **Failing input:** Seat 1 bets 100 then folds to a raise; at showdown seat 1's hand is compared and can win the main pot.
- **Caught by `npm test` today:** yes, indirectly: `agent/poker-scout.test.js` hangs (> 5 min), so CI fails on its 15-minute job timeout rather than on an assertion

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding that names `Table.pots` (or `engine/poker.js` at the changed line) with this failure.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision (T3: ≥ 8/10 hits, ≤ 2 false Important).
