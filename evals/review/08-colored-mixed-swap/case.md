# 08-colored-mixed-swap: Perfect Pairs: colored and mixed pairs are swapped

- **File / function:** `engine/sidebets.js` · `sidebets.pairsHand`
- **Expected severity:** Important
- **Expected lens:** rules (any lens finding it counts)
- **Failing input:** 8♥ 8♦ (same colour) pays 6:1 as a mixed pair; 8♥ 8♠ pays 12:1. Should be the reverse.
- **Caught by `npm test` today:** yes (fail 6)

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding that names `sidebets.pairsHand` (or `engine/sidebets.js` at the changed line) with this failure.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision (T3: ≥ 8/10 hits, ≤ 2 false Important).
