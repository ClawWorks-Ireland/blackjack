# 06-hilo-seven: Hi-Lo counts 7 as +1, so the 'balanced' system no longer sums to 0 over a deck

- **File / function:** `engine/counting.js` · `counting SYSTEMS.hilo`
- **Expected severity:** Important
- **Expected lens:** rules (any lens finding it counts)
- **Failing input:** A full deck counted with Hi-Lo ends at +4 instead of 0; true counts and index plays drift high.
- **Caught by `npm test` today:** yes (fail 4)

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding that names `counting SYSTEMS.hilo` (or `engine/counting.js` at the changed line) with this failure.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision (T3: ≥ 8/10 hits, ≤ 2 false Important).
